import type { ExecutionContext } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";
import { InternalServiceGuard } from "./internal-service.guard.js";

const originalDemoMode = process.env.DEMO_MODE;
const originalToken = process.env.INTERNAL_SERVICE_TOKEN;

afterEach(() => {
  restoreEnv("DEMO_MODE", originalDemoMode);
  restoreEnv("INTERNAL_SERVICE_TOKEN", originalToken);
});

describe("InternalServiceGuard", () => {
  it("accepts the existing internal header and OpenAI Bearer authentication", () => {
    process.env.DEMO_MODE = "false";
    process.env.INTERNAL_SERVICE_TOKEN = "t".repeat(48);
    const guard = new InternalServiceGuard();

    expect(guard.canActivate(context({ "x-internal-service-token": "t".repeat(48) }))).toBe(true);
    expect(guard.canActivate(context({ authorization: `Bearer ${"t".repeat(48)}` }))).toBe(true);
  });

  it("rejects malformed or incorrect Bearer authentication", () => {
    process.env.DEMO_MODE = "false";
    process.env.INTERNAL_SERVICE_TOKEN = "t".repeat(48);
    const guard = new InternalServiceGuard();

    expect(() => guard.canActivate(context({ authorization: `Basic ${"t".repeat(48)}` }))).toThrow("内部工具认证失败");
    expect(() => guard.canActivate(context({ authorization: `Bearer ${"x".repeat(48)}` }))).toThrow("内部工具认证失败");
  });
});

function context(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as never;
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
