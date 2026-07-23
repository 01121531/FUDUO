import { describe, expect, it, vi } from "vitest";
import { HealthController } from "./health.controller.js";

describe("HealthController", () => {
  it("keeps liveness independent from dependencies", () => {
    const controller = new HealthController({ enabled: true } as never, {} as never);
    expect(controller.live()).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ status: "ok" }) }));
  });

  it("returns ready only when PostgreSQL and Redis both respond", async () => {
    const readyReply = reply();
    const ready = new HealthController({ enabled: true, ping: vi.fn().mockResolvedValue(true) } as never, { ping: vi.fn().mockResolvedValue(true) } as never);
    await expect(ready.ready(readyReply as never)).resolves.toEqual(expect.objectContaining({ data: expect.objectContaining({ status: "ready" }) }));
    expect(readyReply.status).toHaveBeenCalledWith(200);

    const failedReply = reply();
    const failed = new HealthController({ enabled: true, ping: vi.fn().mockResolvedValue(true) } as never, { ping: vi.fn().mockResolvedValue(false) } as never);
    await expect(failed.ready(failedReply as never)).resolves.toEqual(expect.objectContaining({ data: expect.objectContaining({ status: "not_ready", checks: { postgres: "ok", redis: "unavailable" } }) }));
    expect(failedReply.status).toHaveBeenCalledWith(503);
  });

  it("marks real dependencies disabled instead of healthy in demo mode", async () => {
    const demoReply = reply();
    const database = { enabled: false, ping: vi.fn() };
    const queue = { ping: vi.fn() };
    const controller = new HealthController(database as never, queue as never);

    await expect(controller.ready(demoReply as never)).resolves.toEqual(expect.objectContaining({
      data: expect.objectContaining({ demoMode: true, checks: { postgres: "disabled", redis: "disabled" } }),
    }));
    expect(database.ping).not.toHaveBeenCalled();
    expect(queue.ping).not.toHaveBeenCalled();
    expect(demoReply.status).toHaveBeenCalledWith(200);
  });
});

function reply() {
  return { status: vi.fn().mockReturnThis() };
}
