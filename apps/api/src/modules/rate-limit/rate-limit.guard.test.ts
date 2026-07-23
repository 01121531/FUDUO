import type { ExecutionContext } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RateLimitPolicy } from "./rate-limit.decorator.js";
import { RateLimitGuard } from "./rate-limit.guard.js";
import { RateLimitBackendError } from "./rate-limit.service.js";

const policy: RateLimitPolicy = {
  name: "chat-turn",
  limit: 30,
  windowSeconds: 60,
  identity: "user",
};

const originalInternalToken = process.env.INTERNAL_SERVICE_TOKEN;

afterEach(() => {
  if (originalInternalToken === undefined) delete process.env.INTERNAL_SERVICE_TOKEN;
  else process.env.INTERNAL_SERVICE_TOKEN = originalInternalToken;
});

describe("RateLimitGuard", () => {
  it("does nothing for endpoints without a declared policy", async () => {
    const consume = vi.fn();
    const guard = new RateLimitGuard({ getAllAndOverride: () => undefined } as never, { consume } as never);
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });

  it("uses the authenticated user and exposes limit metadata without the identity", async () => {
    const consume = vi.fn(async () => ({ allowed: true, limit: 30, remaining: 29, retryAfterSeconds: 60 }));
    const headers = new Map<string, string>();
    const guard = new RateLimitGuard({ getAllAndOverride: () => policy } as never, { consume } as never);

    await expect(guard.canActivate(context({ user: { id: "user-private-id" }, replyHeaders: headers }))).resolves.toBe(true);
    expect(consume).toHaveBeenCalledWith(policy, "user:user-private-id");
    expect(Object.fromEntries(headers)).toEqual({ "RateLimit-Limit": "30", "RateLimit-Remaining": "29", "RateLimit-Reset": "60" });
    expect(JSON.stringify(Object.fromEntries(headers))).not.toContain("user-private-id");
  });

  it("returns a 429 exception and Retry-After after the window is exhausted", async () => {
    const headers = new Map<string, string>();
    const guard = new RateLimitGuard(
      { getAllAndOverride: () => policy } as never,
      { consume: async () => ({ allowed: false, limit: 30, remaining: 0, retryAfterSeconds: 17 }) } as never,
    );

    let caught: unknown;
    try {
      await guard.canActivate(context({ replyHeaders: headers }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(429);
    expect((caught as HttpException).getResponse()).toMatchObject({ code: "RATE_LIMIT_EXCEEDED" });
    expect(headers.get("Retry-After")).toBe("17");
  });

  it("fails closed on backend errors unless the endpoint explicitly opts out", async () => {
    const limits = { consume: async () => { throw new RateLimitBackendError(); } };
    const closed = new RateLimitGuard({ getAllAndOverride: () => policy } as never, limits as never);
    await expect(closed.canActivate(context())).rejects.toMatchObject({ status: 503 });

    const open = new RateLimitGuard({ getAllAndOverride: () => ({ ...policy, failOpen: true }) } as never, limits as never);
    await expect(open.canActivate(context())).resolves.toBe(true);
  });

  it("shares the configured internal credential bucket and falls back to IP for invalid credentials", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "s".repeat(48);
    const internalPolicy: RateLimitPolicy = { ...policy, identity: "internal" };
    const consume = vi.fn(async () => ({ allowed: true, limit: 30, remaining: 29, retryAfterSeconds: 60 }));
    const guard = new RateLimitGuard({ getAllAndOverride: () => internalPolicy } as never, { consume } as never);

    await guard.canActivate(context({ headers: { authorization: `Bearer ${"s".repeat(48)}` }, ip: "10.0.0.2" }));
    expect(consume).toHaveBeenLastCalledWith(internalPolicy, `internal:${"s".repeat(48)}`);
    await guard.canActivate(context({ headers: { authorization: `Bearer ${"x".repeat(48)}` }, ip: "10.0.0.2" }));
    expect(consume).toHaveBeenLastCalledWith(internalPolicy, "ip:10.0.0.2");
  });
});

function context(options: {
  headers?: Record<string, string>;
  ip?: string;
  user?: { id: string };
  replyHeaders?: Map<string, string>;
} = {}): ExecutionContext {
  const replyHeaders = options.replyHeaders ?? new Map<string, string>();
  const request = { headers: options.headers ?? {}, ip: options.ip ?? "127.0.0.1", user: options.user };
  const reply = { header: (name: string, value: string) => { replyHeaders.set(name, value); return reply; } };
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as never;
}
