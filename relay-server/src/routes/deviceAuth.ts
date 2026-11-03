import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import {
  parseRelayV3HttpRequest,
  RELAY_V3_BUSINESS_CODES as CODES,
  RELAY_V3_HTTP,
} from "@zcode/shared/remote-relay-v3";

import type { RelayServerConfig } from "../config.js";
import type { DeviceRow } from "../db.js";
import { insertDeviceWithQuota, QuotaExceededError } from "../db.js";
import { clientIp, replyBusiness, replyOk, requireAccount } from "../http.js";
import { signRelayAccessToken } from "../jwt.js";
import { RELAY_LIMITS } from "../limits.js";
import type { RelayPresence } from "../presence.js";
import type { RelayRuntime } from "../runtime.js";
import { issueRefreshFamily } from "../refreshTokens.js";
import { deviceView } from "./devices.js";

// §5.5 设备授权（headless 设备接入）。信任建立点在批准时刻：relay 在批准时
// 才完成"账号 ↔ 公钥 ↔ 设备记录"绑定，此前该公钥不进入设备目录。
// 待批准请求为进程内存事实（§7）：15 分钟过期，重启即失效，发起方重新发起即
// 换新密钥对。

function deviceMidForPublicKey(publicKey: string): string {
  return `headless_${createHash("sha256").update(publicKey).digest("hex").slice(0, 12)}`;
}

export function registerDeviceAuthRoutes(
  app: FastifyInstance,
  deps: {
    db: DatabaseSync;
    config: RelayServerConfig;
    runtime: RelayRuntime;
    presence: RelayPresence;
  },
): void {
  const { db, config, runtime, presence } = deps;

  app.post(
    RELAY_V3_HTTP.deviceAuthRequest.path,
    { bodyLimit: RELAY_LIMITS.authBodyBytes },
    async (request, reply) => {
      const parsed = parseRelayV3HttpRequest("deviceAuthRequest", request.body);
      if (!parsed) return replyBusiness(reply, CODES.WRONG_PARAM, "parameter error");
      if (!runtime.limiters.deviceAuthRequestPerIp.hit(`ip:${clientIp(request)}`)) {
        return replyBusiness(reply, CODES.RATE_LIMITED, "rate limited");
      }
      const created = runtime.createDeviceAuthRequest(parsed.public_key);
      if (!created) return replyBusiness(reply, CODES.QUOTA_EXCEEDED, "too many pending requests");
      return replyOk(reply, created);
    },
  );

  app.post(
    RELAY_V3_HTTP.deviceAuthApprove.path,
    { bodyLimit: RELAY_LIMITS.authBodyBytes },
    async (request, reply) => {
      const accountId = requireAccount(request, reply, config.jwtSecret, runtime.now);
      if (!accountId) return reply;
      const parsed = parseRelayV3HttpRequest("deviceAuthApprove", request.body);
      if (!parsed) return replyBusiness(reply, CODES.WRONG_PARAM, "parameter error");
      if (!runtime.limiters.deviceAuthApprovePerIp.hit(`ip:${clientIp(request)}`)) {
        return replyBusiness(reply, CODES.RATE_LIMITED, "rate limited");
      }
      const entry = runtime.findDeviceAuthByUserCode(parsed.user_code);
      if (!entry || entry.status !== "pending" || entry.expiresAt <= runtime.now()) {
        return replyBusiness(reply, CODES.EXPIRED, "user code expired");
      }
      if (
        runtime.countApprovedPendingForAccount(accountId) >=
        RELAY_LIMITS.deviceAuthPendingPerAccount
      ) {
        return replyBusiness(reply, CODES.QUOTA_EXCEEDED, "pending approvals quota exceeded");
      }
      // 批准即绑定：设备记录落库，公钥进入目录（§5.5）。
      try {
        const row = insertDeviceWithQuota(
          db,
          {
            accountId,
            deviceMid: deviceMidForPublicKey(entry.publicKey),
            publicKey: entry.publicKey,
          },
          runtime.now,
        );
        entry.accountId = accountId;
        entry.deviceSid = row.sid;
        entry.status = "approved";
        return replyOk(reply, { device: deviceView(row, presence) });
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          return replyBusiness(reply, CODES.QUOTA_EXCEEDED, error.message);
        }
        throw error;
      }
    },
  );

  app.post(
    RELAY_V3_HTTP.deviceAuthPoll.path,
    { bodyLimit: RELAY_LIMITS.authBodyBytes },
    async (request, reply) => {
      const parsed = parseRelayV3HttpRequest("deviceAuthPoll", request.body);
      if (!parsed) return replyBusiness(reply, CODES.WRONG_PARAM, "parameter error");
      if (
        !runtime.limiters.deviceAuthPollPerDeviceCode.hit(`dc:${parsed.device_code.slice(0, 12)}`)
      ) {
        return replyBusiness(reply, CODES.RATE_LIMITED, "rate limited");
      }
      const entry = runtime.findDeviceAuthByDeviceCode(parsed.device_code);
      if (!entry) return replyBusiness(reply, CODES.AUTH_FAILED, "unknown device code");
      if (entry.expiresAt <= runtime.now()) return replyBusiness(reply, CODES.EXPIRED, "expired");
      if (entry.status === "pending") return replyOk(reply, { status: "pending" });
      if (entry.status === "consumed")
        return replyBusiness(reply, CODES.WRONG_STATE, "already used");
      // 批准后凭据经 poll 交付给发起方；refresh 家族语义与 §3.3 一致。
      const row = db.prepare("SELECT * FROM devices WHERE sid = ?").get(entry.deviceSid!) as
        | DeviceRow
        | undefined;
      if (!row) return replyBusiness(reply, CODES.INTERNAL, "device missing");
      try {
        const family = issueRefreshFamily(db, entry.accountId!, runtime.now);
        const access = signRelayAccessToken(config.jwtSecret, entry.accountId!, runtime.now);
        entry.status = "consumed";
        runtime.deviceAuthByUserCode.delete(entry.userCode);
        return replyOk(reply, {
          access,
          refresh: family.refresh,
          device: deviceView(row, presence),
        });
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          return replyBusiness(reply, CODES.QUOTA_EXCEEDED, error.message);
        }
        throw error;
      }
    },
  );
}
