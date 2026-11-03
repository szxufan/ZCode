import type { FastifyInstance } from "fastify";
import type { DatabaseSync } from "node:sqlite";

import {
  parseRelayV3HttpRequest,
  RELAY_V3_BUSINESS_CODES as CODES,
  RELAY_V3_HTTP,
  type RelayV3Device,
} from "@zcode/shared/remote-relay-v3";

import type { RelayServerConfig } from "../config.js";
import type { DeviceRow } from "../db.js";
import { insertDeviceWithQuota, QuotaExceededError } from "../db.js";
import { replyBusiness, replyOk, requireAccount } from "../http.js";
import { RELAY_LIMITS } from "../limits.js";
import type { RelayPresence } from "../presence.js";
import type { RelayRuntime } from "../runtime.js";

// §5.1 设备目录：注册（新 SID+新公钥）、列表（online 由 presence 计算）、
// 删除（仅离线、幂等、越权 no permission）。relay/token 签发一次性 ws token。

export function deviceView(row: DeviceRow, presence: RelayPresence): RelayV3Device {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(row.meta) as Record<string, unknown>;
  } catch {
    meta = {};
  }
  return {
    device_sid: row.sid,
    device_mid: row.device_mid,
    public_key: row.public_key,
    online: presence.isOnline(row.sid),
    created_at: row.created_at,
    meta: meta as RelayV3Device["meta"],
  };
}

export function registerDeviceRoutes(
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
    RELAY_V3_HTTP.register.path,
    { bodyLimit: RELAY_LIMITS.cipherBodyBytes },
    async (request, reply) => {
      const accountId = requireAccount(request, reply, config.jwtSecret, runtime.now);
      if (!accountId) return reply;
      const parsed = parseRelayV3HttpRequest("register", request.body);
      if (!parsed) return replyBusiness(reply, CODES.WRONG_PARAM, "parameter error");
      try {
        const row = insertDeviceWithQuota(
          db,
          { accountId, deviceMid: parsed.device_mid, publicKey: parsed.public_key },
          runtime.now,
        );
        return replyOk(reply, deviceView(row, presence));
      } catch (error) {
        if (error instanceof QuotaExceededError) {
          return replyBusiness(reply, CODES.QUOTA_EXCEEDED, error.message);
        }
        throw error;
      }
    },
  );

  app.get(RELAY_V3_HTTP.list.path, async (request, reply) => {
    const accountId = requireAccount(request, reply, config.jwtSecret, runtime.now);
    if (!accountId) return reply;
    const rows = db
      .prepare(
        "SELECT * FROM devices WHERE account_id = ? AND deleted_at IS NULL ORDER BY created_at",
      )
      .all(accountId) as unknown as DeviceRow[];
    return replyOk(
      reply,
      rows.map((row) => deviceView(row, presence)),
    );
  });

  app.post(
    RELAY_V3_HTTP.delete.path,
    { bodyLimit: RELAY_LIMITS.authBodyBytes },
    async (request, reply) => {
      const accountId = requireAccount(request, reply, config.jwtSecret, runtime.now);
      if (!accountId) return reply;
      const parsed = parseRelayV3HttpRequest("delete", request.body);
      if (!parsed) return replyBusiness(reply, CODES.WRONG_PARAM, "parameter error");
      const row = db
        .prepare("SELECT * FROM devices WHERE sid = ? AND deleted_at IS NULL")
        .get(parsed.device_sid) as DeviceRow | undefined;
      // 删除幂等：不存在（或已删）直接成功。
      if (!row) return replyOk(reply);
      if (row.account_id !== accountId) {
        return replyBusiness(reply, CODES.NO_PERMISSION, "no permission");
      }
      if (presence.isOnline(row.sid)) {
        return replyBusiness(reply, CODES.WRONG_STATE, "device online");
      }
      db.prepare("UPDATE devices SET deleted_at = ? WHERE sid = ?").run(
        Math.floor(runtime.now() / 1000),
        row.sid,
      );
      return replyOk(reply);
    },
  );

  app.post(
    RELAY_V3_HTTP.relayToken.path,
    { bodyLimit: RELAY_LIMITS.authBodyBytes },
    async (request, reply) => {
      const accountId = requireAccount(request, reply, config.jwtSecret, runtime.now);
      if (!accountId) return reply;
      const parsed = parseRelayV3HttpRequest("relayToken", request.body);
      if (!parsed) return replyBusiness(reply, CODES.WRONG_PARAM, "parameter error");
      return replyOk(reply, runtime.issueWsToken(accountId, parsed.role));
    },
  );
}
