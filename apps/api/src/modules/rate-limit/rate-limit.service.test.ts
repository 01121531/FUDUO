import { afterEach, describe, expect, it } from "vitest";
import type { RateLimitPolicy } from "./rate-limit.decorator.js";
import { buildRateLimitKey, RateLimitBackendError, RateLimitService } from "./rate-limit.service.js";

const policy: RateLimitPolicy = {
  name: "test-login",
  limit: 2,
  windowSeconds: 60,
  identity: "ip",
};

const originalRedisUrl = process.env.REDIS_URL;

afterEach(() => {
  if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedisUrl;
});

describe("RateLimitService", () => {
  it("enforces a fixed window and permits requests after it expires", async () => {
    const service = new RateLimitService({ enabled: false } as never);

    await expect(service.consume(policy, "ip:127.0.0.1", 1_000)).resolves.toMatchObject({ allowed: true, remaining: 1, retryAfterSeconds: 60 });
    await expect(service.consume(policy, "ip:127.0.0.1", 2_000)).resolves.toMatchObject({ allowed: true, remaining: 0, retryAfterSeconds: 59 });
    await expect(service.consume(policy, "ip:127.0.0.1", 3_000)).resolves.toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 58 });
    await expect(service.consume(policy, "ip:127.0.0.1", 61_000)).resolves.toMatchObject({ allowed: true, remaining: 1, retryAfterSeconds: 60 });
  });

  it("keeps identities isolated and hashes identity material in storage keys", async () => {
    const service = new RateLimitService({ enabled: false } as never);
    await service.consume(policy, "user:employee-one", 1_000);
    await service.consume(policy, "user:employee-one", 1_000);

    await expect(service.consume(policy, "user:employee-two", 1_000)).resolves.toMatchObject({ allowed: true, remaining: 1 });
    const key = buildRateLimitKey(policy.name, "user:employee-one");
    expect(key).toMatch(/^rate-limit:v1:test-login:[a-f0-9]{64}$/);
    expect(key).not.toContain("employee-one");
    expect(buildRateLimitKey(policy.name, "user:employee-two")).not.toBe(key);
  });

  it("fails closed when the production Redis backend is not configured", async () => {
    delete process.env.REDIS_URL;
    const service = new RateLimitService({ enabled: true } as never);
    await expect(service.consume(policy, "ip:127.0.0.1")).rejects.toBeInstanceOf(RateLimitBackendError);
  });
});
