import { timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply } from "fastify";
import { RATE_LIMIT_POLICY, type RateLimitPolicy } from "./rate-limit.decorator.js";
import { RateLimitBackendError, RateLimitService } from "./rate-limit.service.js";

interface RateLimitedRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
  user?: { id: string };
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RateLimitService) private readonly limits: RateLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<RateLimitPolicy>(RATE_LIMIT_POLICY, [context.getHandler(), context.getClass()]);
    if (!policy) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<RateLimitedRequest>();
    const reply = http.getResponse<FastifyReply>();
    try {
      const result = await this.limits.consume(policy, resolveIdentity(policy, request));
      reply.header("RateLimit-Limit", String(result.limit));
      reply.header("RateLimit-Remaining", String(result.remaining));
      reply.header("RateLimit-Reset", String(result.retryAfterSeconds));
      if (result.allowed) return true;

      reply.header("Retry-After", String(result.retryAfterSeconds));
      throw new HttpException({
        code: "RATE_LIMIT_EXCEEDED",
        message: "请求过于频繁，请稍后重试",
      }, 429);
    } catch (error) {
      if (!(error instanceof RateLimitBackendError)) throw error;
      if (policy.failOpen) return true;
      throw new HttpException({
        code: "RATE_LIMIT_UNAVAILABLE",
        message: "请求保护服务暂不可用",
        recovery: "请稍后重试",
      }, 503);
    }
  }
}

function resolveIdentity(policy: RateLimitPolicy, request: RateLimitedRequest) {
  const ip = request.ip ?? request.socket?.remoteAddress ?? "unknown";
  if (policy.identity === "ip") return `ip:${ip}`;
  if (policy.identity === "user") return request.user?.id ? `user:${request.user.id}` : `ip:${ip}`;

  const supplied = internalCredential(request.headers);
  const expected = process.env.INTERNAL_SERVICE_TOKEN;
  if (supplied && expected && safeEqual(supplied, expected)) return `internal:${supplied}`;
  return `ip:${ip}`;
}

function internalCredential(headers: RateLimitedRequest["headers"]) {
  const direct = first(headers["x-internal-service-token"]);
  if (direct) return direct;
  const authorization = first(headers.authorization);
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
