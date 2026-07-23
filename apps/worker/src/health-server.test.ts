import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerHealthServer, type WorkerHealthChecks } from "./health-server.js";

const servers: ReturnType<typeof createWorkerHealthServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("worker health server", () => {
  it("keeps liveness independent from queue and dependency checks", async () => {
    const checks: WorkerHealthChecks = {
      workerRunning: vi.fn(() => false),
      postgresPing: vi.fn(async () => false),
      redisPing: vi.fn(async () => false),
    };
    const baseUrl = await listen(checks);
    const response = await fetch(`${baseUrl}/health/live`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ status: "ok", timestamp: expect.any(String) }));
    expect(checks.workerRunning).not.toHaveBeenCalled();
    expect(checks.postgresPing).not.toHaveBeenCalled();
    expect(checks.redisPing).not.toHaveBeenCalled();
  });

  it("is ready only when BullMQ, PostgreSQL, and Redis are available", async () => {
    const baseUrl = await listen({
      workerRunning: () => true,
      postgresPing: async () => true,
      redisPing: async () => true,
    });
    const response = await fetch(`${baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      status: "ready",
      checks: { worker: "ok", postgres: "ok", redis: "ok" },
    }));
  });

  it("returns a stable 503 response and hides dependency errors", async () => {
    const baseUrl = await listen({
      workerRunning: () => false,
      postgresPing: async () => { throw new Error("postgresql://secret@database"); },
      redisPing: async () => false,
    });
    const response = await fetch(`${baseUrl}/health/ready`);
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual(expect.objectContaining({
      status: "not_ready",
      checks: { worker: "unavailable", postgres: "unavailable", redis: "unavailable" },
    }));
    expect(text).not.toContain("secret");
  });

  it("does not expose unrelated routes or mutation methods", async () => {
    const baseUrl = await listen({ workerRunning: () => true, postgresPing: async () => true, redisPing: async () => true });
    expect((await fetch(`${baseUrl}/metrics`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/health/live`, { method: "POST" })).status).toBe(405);
  });
});

async function listen(checks: WorkerHealthChecks) {
  const server = createWorkerHealthServer(checks);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
