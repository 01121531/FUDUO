import { describe, expect, it, vi } from "vitest";
import { createReadinessCheck } from "./readiness.js";

describe("OpenClaw admin readiness", () => {
  it("is ready only when the shared state directory is accessible and the Gateway is ready", async () => {
    const accessImpl = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => new Response('{"status":"ready"}', { status: 200 }));
    const check = createReadinessCheck({
      stateDir: "/state",
      gatewayHealthUrl: "http://openclaw:18789/readyz",
      accessImpl,
      fetchImpl,
    });

    await expect(check()).resolves.toBe(true);
    expect(accessImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("http://openclaw:18789/readyz", expect.objectContaining({ method: "GET" }));
  });

  it("does not contact the Gateway when the state directory is unavailable", async () => {
    const fetchImpl = vi.fn();
    const check = createReadinessCheck({
      stateDir: "/state",
      gatewayHealthUrl: "http://openclaw:18789/readyz",
      accessImpl: vi.fn(async () => { throw new Error("permission denied: /sensitive/path"); }),
      fetchImpl,
    });

    await expect(check()).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns false for an unhealthy Gateway without exposing its response", async () => {
    const check = createReadinessCheck({
      stateDir: "/state",
      gatewayHealthUrl: "http://openclaw:18789/readyz",
      accessImpl: vi.fn(async () => undefined),
      fetchImpl: vi.fn(async () => new Response("secret diagnostic", { status: 503 })),
    });

    await expect(check()).resolves.toBe(false);
  });

  it("rejects credential-bearing or non-readiness URLs", () => {
    expect(() => createReadinessCheck({ stateDir: "/state", gatewayHealthUrl: "http://token@openclaw:18789/readyz" })).toThrowError("OPENCLAW_GATEWAY_HEALTH_URL_INVALID");
    expect(() => createReadinessCheck({ stateDir: "/state", gatewayHealthUrl: "https://openclaw:18789/health" })).toThrowError("OPENCLAW_GATEWAY_HEALTH_URL_INVALID");
  });
});
