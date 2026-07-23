import { createServer } from "node:http";

export interface WorkerHealthChecks {
  workerRunning(): boolean;
  postgresPing(): Promise<boolean>;
  redisPing(): Promise<boolean>;
}

export function createWorkerHealthServer(checks: WorkerHealthChecks) {
  return createServer(async (request, response) => {
    if (request.method !== "GET") return send(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
    if (request.url === "/health/live") {
      return send(response, 200, { status: "ok", timestamp: new Date().toISOString() });
    }
    if (request.url === "/health/ready") {
      const [postgres, redis] = await Promise.all([
        bounded(checks.postgresPing()),
        bounded(checks.redisPing()),
      ]);
      const worker = checks.workerRunning();
      const ready = worker && postgres && redis;
      return send(response, ready ? 200 : 503, {
        status: ready ? "ready" : "not_ready",
        checks: {
          worker: worker ? "ok" : "unavailable",
          postgres: postgres ? "ok" : "unavailable",
          redis: redis ? "ok" : "unavailable",
        },
        timestamp: new Date().toISOString(),
      });
    }
    return send(response, 404, { error: { code: "NOT_FOUND" } });
  });
}

async function bounded(check: Promise<boolean>) {
  try {
    return await Promise.race([check, timeout(false, 2_000)]);
  } catch {
    return false;
  }
}

function timeout<T>(value: T, milliseconds: number) {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(value), milliseconds);
    timer.unref();
  });
}

function send(response: import("node:http").ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}
