import { createHmac } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureUploadGuard } from "./capture-upload.guard.js";

const originalSecret = process.env.CAPTURE_UPLOAD_SECRET;
const secret = "capture-secret-with-at-least-32-random-characters";

afterEach(() => {
  vi.useRealTimers();
  if (originalSecret === undefined) delete process.env.CAPTURE_UPLOAD_SECRET;
  else process.env.CAPTURE_UPLOAD_SECRET = originalSecret;
});

describe("CaptureUploadGuard", () => {
  it("accepts a current HMAC that covers the complete Authorization value", () => {
    process.env.CAPTURE_UPLOAD_SECRET = secret;
    const authorization = "Bearer header.payload.signature";
    const timestamp = String(Date.now());
    const signature = sign(timestamp, authorization);

    expect(new CaptureUploadGuard().canActivate(context(timestamp, signature, authorization))).toBe(true);
  });

  it("rejects a signature after the Authorization body is changed", () => {
    process.env.CAPTURE_UPLOAD_SECRET = secret;
    const timestamp = String(Date.now());
    const signature = sign(timestamp, "Bearer original-token");

    expect(() => new CaptureUploadGuard().canActivate(context(timestamp, signature, "Bearer changed-token")))
      .toThrow("捕获插件签名无效");
  });

  it("rejects signatures outside the five-minute clock window", () => {
    process.env.CAPTURE_UPLOAD_SECRET = secret;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-22T12:00:00.000Z"));
    const timestamp = String(Date.now() - 5 * 60_000 - 1);

    expect(() => new CaptureUploadGuard().canActivate(context(timestamp, sign(timestamp, "Bearer token"), "Bearer token")))
      .toThrow("捕获插件请求已过期");
  });

  it("fails closed when the shared upload secret is not configured", () => {
    delete process.env.CAPTURE_UPLOAD_SECRET;

    expect(() => new CaptureUploadGuard().canActivate(context(String(Date.now()), "signature", "Bearer token")))
      .toThrow("CAPTURE_UPLOAD_SECRET must contain at least 32 characters");
  });
});

function sign(timestamp: string, authorization: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${authorization}`).digest("hex");
}

function context(timestamp: string, signature: string, authorization: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: {
          "x-capture-timestamp": timestamp,
          "x-capture-signature": signature,
        },
        body: { authorization },
      }),
    }),
  } as never;
}
