import { describe, expect, it, vi } from "vitest";
import { enqueueReportDeliveries, executeReportDelivery, reconcileQueuedReportDeliveries, requestReportGeneration } from "./report-api.js";

const deliveryId = "550e8400-e29b-41d4-a716-446655440000";
const options = (fetchImpl: typeof fetch) => ({ apiUrl: "http://api:3001/api/", token: "x".repeat(48), fetchImpl });

describe("worker report API", () => {
  it("requests report generation and returns delivery references", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://api:3001/api/tools/generate_daily_report");
      expect(new Headers(init?.headers).get("X-Internal-Service-Token")).toBe("x".repeat(48));
      expect(JSON.parse(String(init?.body))).toEqual({ shopIds: ["101"], scheduledReportId: deliveryId, date: "2026-07-21" });
      return new Response(JSON.stringify({ success: true, data: { id: "report-1", deliveries: [{ id: deliveryId, channel: "WECHAT", status: "QUEUED" }] } }), { status: 200 });
    });

    await expect(requestReportGeneration("DAILY", ["101"], deliveryId, "2026-07-21", options(fetchImpl as typeof fetch))).resolves.toMatchObject({
      deliveries: [{ id: deliveryId, channel: "WECHAT", status: "QUEUED" }],
    });
  });

  it("enqueues only valid queued WeChat deliveries with stable retry settings", async () => {
    const queue = { add: vi.fn(async () => ({})) };
    const count = await enqueueReportDeliveries(queue as never, {
      deliveries: [
        { id: deliveryId, channel: "WECHAT", status: "QUEUED" },
        { id: "invalid", channel: "WECHAT", status: "QUEUED" },
        { id: "650e8400-e29b-41d4-a716-446655440000", channel: "WEB", status: "SUCCEEDED" },
      ],
    });

    expect(count).toBe(1);
    expect(queue.add).toHaveBeenCalledWith("channel-delivery", { reportDeliveryId: deliveryId }, {
      jobId: `channel-delivery-${deliveryId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: 500,
      removeOnFail: 1_000,
    });
  });

  it("executes a delivery through the authenticated internal endpoint", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(`http://api:3001/api/internal/report-deliveries/${deliveryId}/execute`);
      expect(init?.body).toBeUndefined();
      return new Response(JSON.stringify({ success: true, data: { id: deliveryId, status: "SUCCEEDED" } }), { status: 200 });
    });

    await expect(executeReportDelivery(deliveryId, options(fetchImpl as typeof fetch))).resolves.toMatchObject({ status: "SUCCEEDED" });
  });

  it("recovers orphaned queued deliveries without duplicating active jobs", async () => {
    const second = "650e8400-e29b-41d4-a716-446655440000";
    const third = "750e8400-e29b-41d4-a716-446655440000";
    const fourth = "850e8400-e29b-41d4-a716-446655440000";
    const failed = { getState: vi.fn(async () => "failed"), retry: vi.fn(async () => undefined), remove: vi.fn() };
    const completed = { getState: vi.fn(async () => "completed"), retry: vi.fn(), remove: vi.fn(async () => undefined) };
    const active = { getState: vi.fn(async () => "active"), retry: vi.fn(), remove: vi.fn() };
    const queue = {
      add: vi.fn(async () => ({})),
      getJob: vi.fn(async (jobId: string) => jobId.endsWith(second) ? failed : jobId.endsWith(third) ? completed : jobId.endsWith(fourth) ? active : undefined),
    };
    const source = { reportDelivery: { findMany: vi.fn(async () => [delivery(deliveryId), delivery(second), delivery(third), delivery(fourth)]) } };

    await expect(reconcileQueuedReportDeliveries(source, queue as never)).resolves.toEqual({ found: 4, added: 2, retried: 1 });
    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(failed.retry).toHaveBeenCalledWith("failed");
    expect(completed.remove).toHaveBeenCalledOnce();
    expect(active.retry).not.toHaveBeenCalled();
    expect(source.reportDelivery.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ channel: "WECHAT", OR: expect.arrayContaining([expect.objectContaining({ status: "SENDING" })]) }),
    }));
  });

  it("requeues an expired sending delivery after its completed retry job", async () => {
    const completed = { getState: vi.fn(async () => "completed"), retry: vi.fn(), remove: vi.fn(async () => undefined) };
    const queue = { add: vi.fn(async () => ({})), getJob: vi.fn(async () => completed) };
    const source = { reportDelivery: { findMany: vi.fn(async () => [{ id: deliveryId, channel: "WECHAT", status: "SENDING" }]) } };

    await expect(reconcileQueuedReportDeliveries(source, queue as never)).resolves.toEqual({ found: 1, added: 1, retried: 0 });
    expect(completed.remove).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledOnce();
  });

  it("refuses to send the internal token to a non-internal host", async () => {
    const fetchImpl = vi.fn();
    await expect(requestReportGeneration("DAILY", undefined, undefined, undefined, {
      apiUrl: "https://attacker.example/api",
      token: "x".repeat(48),
      fetchImpl: fetchImpl as typeof fetch,
    })).rejects.toMatchObject({ code: "INTERNAL_API_URL_NOT_ALLOWED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts a stalled internal request with a stable timeout code", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }));
      const pending = requestReportGeneration("DAILY", undefined, undefined, undefined, {
        ...options(fetchImpl as typeof fetch),
        timeoutMs: 25,
      });
      const rejection = expect(pending).rejects.toMatchObject({ code: "INTERNAL_API_TIMEOUT", status: 504 });
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects oversized and malformed internal API envelopes", async () => {
    const oversized = vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Length": "1000001" } }));
    await expect(requestReportGeneration("DAILY", undefined, undefined, undefined, options(oversized as typeof fetch)))
      .rejects.toMatchObject({ code: "INTERNAL_API_RESPONSE_TOO_LARGE" });

    const malformed = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    await expect(requestReportGeneration("DAILY", undefined, undefined, undefined, options(malformed as typeof fetch)))
      .rejects.toMatchObject({ code: "INTERNAL_API_RESPONSE_INVALID" });
  });
});

function delivery(id: string) { return { id, channel: "WECHAT", status: "QUEUED" }; }
