import { describe, expect, it } from "vitest";
import { normalizeTraceId, runWithRequestContext } from "./request-context.js";
import { ok } from "./response.js";

describe("API response trace context", () => {
  it("uses the request trace id in a success envelope", async () => {
    await runWithRequestContext("trace-request-42", async () => {
      await Promise.resolve();
      expect(ok({ ready: true }).meta.traceId).toBe("trace-request-42");
    });
  });

  it("rejects unsafe or oversized incoming trace ids", () => {
    expect(normalizeTraceId("trace.good:1")).toBe("trace.good:1");
    expect(normalizeTraceId("bad trace\nvalue")).not.toBe("bad trace\nvalue");
    expect(normalizeTraceId("x".repeat(129))).not.toBe("x".repeat(129));
  });

  it("generates a trace id outside request scope", () => {
    expect(ok(null).meta.traceId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
