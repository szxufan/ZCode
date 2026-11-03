import type { FastifyReply, FastifyRequest } from "fastify";

import { RELAY_V3_BUSINESS_CODES } from "@zcode/shared/remote-relay-v3";

import { verifyRelayAccessToken } from "./jwt.js";

// §5 前言：成功信封 {code: 0, msg, data}；业务失败 HTTP 200 + 非零 code。
// 传输层失败（413/503/404 等）可能无 JSON 正文，调用方必须同时检查两者。

export function replyOk(reply: FastifyReply, data: unknown = null): FastifyReply {
  return reply.status(200).send({ code: RELAY_V3_BUSINESS_CODES.OK, msg: "ok", data });
}

export function replyBusiness(reply: FastifyReply, code: number, msg: string): FastifyReply {
  return reply.status(200).send({ code, msg, data: null });
}

export function clientIp(request: FastifyRequest): string {
  // 自部署默认处于反向代理之后；仅当直连本机时信任 X-Forwarded-For 首跳。
  const forwarded = request.headers["x-forwarded-for"];
  const remote = request.socket.remoteAddress ?? "unknown";
  const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  if (isLoopback && typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0]!.trim();
  }
  return remote;
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const match = header.match(/^Bearer (.+)$/i);
  return match?.[1] ?? null;
}

/** 校验 Bearer access token；失败时已写入业务错误并返回 null。 */
export function requireAccount(
  request: FastifyRequest,
  reply: FastifyReply,
  jwtSecret: string,
  now: () => number = Date.now,
): string | null {
  const token = bearerToken(request);
  if (!token) {
    replyBusiness(reply, RELAY_V3_BUSINESS_CODES.AUTH_FAILED, "unauthorized");
    return null;
  }
  const claims = verifyRelayAccessToken(jwtSecret, token, now);
  if (!claims) {
    replyBusiness(reply, RELAY_V3_BUSINESS_CODES.AUTH_FAILED, "unauthorized");
    return null;
  }
  return claims.sub;
}
