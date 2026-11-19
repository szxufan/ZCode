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
  // Fastify 在配置 trustProxy 后会解析真实客户端地址；此时直接采用 request.ip。
  const remote = request.socket.remoteAddress ?? "unknown";
  if (request.ip && request.ip !== remote) return request.ip;
  // 未配置 trustProxy 时只在直连 loopback（本机开发/本机反代）信任 X-Forwarded-For 首跳，
  // 避免公网客户端伪造该头绕过按 IP 限流。
  const forwarded = request.headers["x-forwarded-for"];
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
