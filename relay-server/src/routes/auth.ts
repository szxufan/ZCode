import type { FastifyInstance, FastifyReply } from "fastify";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import {
  parseRelayV3HttpRequest,
  RELAY_V3_BUSINESS_CODES as CODES,
  RELAY_V3_HTTP,
} from "@zcode/shared/remote-relay-v3";

import type { RelayServerConfig } from "../config.js";
import { bearerToken, clientIp, replyBusiness, replyOk } from "../http.js";
import { signRelayAccessToken, verifyRelayAccessToken } from "../jwt.js";
import { loginLockoutSeconds, RELAY_LIMITS } from "../limits.js";
import { verifyRelayPassword } from "../passwords.js";
import {
  issueRefreshFamily,
  RefreshRejectedError,
  revokeFamiliesForAccount,
  rotateRefreshToken,
} from "../refreshTokens.js";
import type { RelayRuntime } from "../runtime.js";
import { smsSendAdmitted } from "../runtime.js";
import { checkSmsCode, storeSmsCode } from "../smsCodes.js";
import type { RelaySmsTransport } from "../smsProvider.js";

// §3 账号与登录。首次验证码登录成功即建号；closed 时仅预建账号可登录；
// 密码登录兜底短信不可用场景。锁定与限流常量见 limits.ts。

function maskPhone(phone: string): string {
  if (phone.length <= 6) return `${phone.slice(0, 3)}****`;
  return `${phone.slice(0, phone.length - 6)}****${phone.slice(-2)}`;
}

/** 连续失败按账号指数锁定（5 次失败锁 5 分钟起步，§3.2）；未知账号不建行。 */
function registerLoginFailure(db: DatabaseSync, accountId: string | null, now: () => number): void {
  if (!accountId) return;
  const row = db.prepare("SELECT failed_attempts FROM accounts WHERE id = ?").get(accountId) as
    | { failed_attempts: number }
    | undefined;
  if (!row) return;
  const failures = row.failed_attempts + 1;
  db.prepare("UPDATE accounts SET failed_attempts = ?, locked_until = ? WHERE id = ?").run(
    failures,
    Math.floor(now() / 1000) + loginLockoutSeconds(failures),
    accountId,
  );
}

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: {
    db: DatabaseSync;
    config: RelayServerConfig;
    runtime: RelayRuntime;
    smsTransport: RelaySmsTransport;
  },
): void {
  const { db, config, runtime, smsTransport } = deps;

  app.post(
    RELAY_V3_HTTP.smsCode.path,
    { bodyLimit: RELAY_LIMITS.authBodyBytes },
    async (request, reply) => {
      const parsed = parseRelayV3HttpRequest("smsCode", request.body);
      if (!parsed) return replyBusiness(reply, CODES.WRONG_PARAM, "parameter error");
      const ip = clientIp(request);
      if (!runtime.limiters.smsSendPerIp.hit(`ip:${ip}`)) {
        return replyBusiness(reply, CODES.RATE_LIMITED, "rate limited");
      }
      if (config.sms.provider === "none") {
        return reply.status(503).send({ code: CODES.SMS_UNAVAILABLE, msg: "sms not configured" });
      }
      if (!smsSendAdmitted(runtime, parsed.phone, "check")) {
        return replyBusiness(reply, CODES.RATE_LIMITED, "rate limited");
      }
      const code = storeSmsCode(db, { phone: parsed.phone, requestIp: ip }, runtime.now);
      try {
        await smsTransport.send(parsed.phone, code);
      } catch {
        return reply.status(502).send({ code: CODES.SMS_UNAVAILABLE, msg: "sms send failed" });
      }
      smsSendAdmitted(runtime, parsed.phone, "consume");
      return replyOk(reply);
    },
  );

  app.post(
    RELAY_V3_HTTP.login.path,
    { bodyLimit: RELAY_LIMITS.authBodyBytes },
    async (request, reply) => {
      const parsed = parseRelayV3HttpRequest("login", request.body);
      if (!parsed) return replyBusiness(reply, CODES.WRONG_PARAM, "parameter error");
      const ip = clientIp(request);
      const account = db.prepare("SELECT * FROM accounts WHERE phone_e164 = ?").get(parsed.phone) as
        | {
            id: string;
            password_scrypt: string | null;
            failed_attempts: number;
            locked_until: number;
          }
        | undefined;
      const nowSeconds = Math.floor(runtime.now() / 1000);
      if (account && account.locked_until > nowSeconds) {
        return replyBusiness(reply, CODES.LOCKED, "account locked");
      }
      const loginFailed = () => registerLoginFailure(db, account?.id ?? null, runtime.now);
      const loginSucceeded = () =>
        db
          .prepare("UPDATE accounts SET failed_attempts = 0, locked_until = 0 WHERE id = ?")
          .run(account!.id);

      if ("code" in parsed) {
        if (!runtime.limiters.smsVerifyPerIp.hit(`ip:${ip}`)) {
          return replyBusiness(reply, CODES.RATE_LIMITED, "rate limited");
        }
        const check = checkSmsCode(db, parsed.phone, parsed.code, runtime.now);
        if (!check.ok) {
          loginFailed();
          return replyBusiness(reply, CODES.AUTH_FAILED, "invalid credentials");
        }
        if (!account) {
          if (config.localRegistration === "closed") {
            return replyBusiness(reply, CODES.AUTH_FAILED, "registration closed");
          }
          const id = `acct_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
          db.prepare("INSERT INTO accounts (id, phone_e164, created_at) VALUES (?, ?, ?)").run(
            id,
            parsed.phone,
            nowSeconds,
          );
          return completeLogin(reply, id, parsed.phone);
        }
        loginSucceeded();
        return completeLogin(reply, account.id, parsed.phone);
      }

      // 密码登录：短信不可用时的兜底（§3.1）。
      if (!account || !verifyRelayPassword(parsed.password, account.password_scrypt)) {
        loginFailed();
        return replyBusiness(reply, CODES.AUTH_FAILED, "invalid credentials");
      }
      loginSucceeded();
      return completeLogin(reply, account.id, parsed.phone);
    },
  );

  app.post(
    RELAY_V3_HTTP.refresh.path,
    { bodyLimit: RELAY_LIMITS.authBodyBytes },
    async (request, reply) => {
      const parsed = parseRelayV3HttpRequest("refresh", request.body);
      if (!parsed) return replyBusiness(reply, CODES.WRONG_PARAM, "parameter error");
      if (!runtime.limiters.refreshPerIp.hit(`ip:${clientIp(request)}`)) {
        return replyBusiness(reply, CODES.RATE_LIMITED, "rate limited");
      }
      try {
        const rotated = rotateRefreshToken(db, parsed.refresh, runtime.now);
        const access = signRelayAccessToken(config.jwtSecret, rotated.accountId, runtime.now);
        return replyOk(reply, { access, refresh: rotated.refresh });
      } catch (error) {
        if (error instanceof RefreshRejectedError) {
          return replyBusiness(reply, CODES.AUTH_FAILED, "session expired");
        }
        throw error;
      }
    },
  );

  app.post(
    RELAY_V3_HTTP.logout.path,
    { bodyLimit: RELAY_LIMITS.authBodyBytes },
    async (request, reply) => {
      const token = bearerToken(request);
      const claims = token ? verifyRelayAccessToken(config.jwtSecret, token, runtime.now) : null;
      if (claims) {
        revokeFamiliesForAccount(db, claims.sub, runtime.now);
      }
      return replyOk(reply);
    },
  );

  function completeLogin(reply: FastifyReply, accountId: string, phone: string) {
    let family: { refresh: string };
    try {
      family = issueRefreshFamily(db, accountId, runtime.now);
    } catch {
      return replyBusiness(reply, CODES.QUOTA_EXCEEDED, "credential quota exceeded");
    }
    const access = signRelayAccessToken(config.jwtSecret, accountId, runtime.now);
    return replyOk(reply, {
      access,
      refresh: family.refresh,
      account: { id: accountId, phone_masked: maskPhone(phone) },
    });
  }
}
