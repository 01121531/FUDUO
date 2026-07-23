import { describe, expect, it, vi } from "vitest";
import { MetricsService } from "./metrics.service.js";

describe("MetricsService", () => {
  it("records bounded route labels without request bodies or credentials", async () => {
    const metrics = new MetricsService({ enabled: false } as never);
    metrics.observeHttp("GET", "/api/shops/123456?authorization=Bearer-secret", 200, 0.25);
    const output = await metrics.render();

    expect(output).toContain('http_requests_total{method="GET",route="/api/shops/:id",status="200"} 1');
    expect(output).toContain("http_request_duration_seconds_sum");
    expect(output).not.toContain("authorization");
    expect(output).not.toContain("Bearer-secret");
  });

  it("exports persistent synchronization, model, tool, delivery and freshness metrics", async () => {
    const database = {
      enabled: true,
      prisma: {
        $queryRawUnsafe: vi.fn().mockResolvedValue([{ count: 5n, sumSeconds: 12.5 }]),
        syncRun: { count: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(3).mockResolvedValueOnce(1) },
        toolRun: {
          aggregate: vi.fn()
            .mockResolvedValueOnce({ _count: { id: 7 }, _sum: { durationMs: 3_500 } })
            .mockResolvedValueOnce({ _count: { id: 2 }, _sum: { durationMs: 4_250 } }),
        },
        modelProvider: { aggregate: vi.fn().mockResolvedValue({ _sum: { requestCount: 10, failureCount: 2 } }) },
        reportDelivery: { count: vi.fn().mockResolvedValue(4) },
        shop: {
          findMany: vi.fn().mockResolvedValue([{
            fuduoShopId: 2255n,
            dataSyncStates: [
              { dataType: "sales", lastSuccessAt: new Date(Date.now() - 10_000) },
              { dataType: "orders", lastSuccessAt: new Date(Date.now() - 20_000) },
            ],
          }]),
        },
      },
    };
    const output = await new MetricsService(database as never).render();

    expect(output).toContain("sync_job_duration_seconds_count 5");
    expect(output).toContain("sync_job_duration_seconds_sum 12.5");
    expect(output).toContain("sync_job_failures_total 2");
    expect(output).toContain('credential_refresh_total{result="succeeded"} 3');
    expect(output).toContain("tool_call_duration_seconds_count 7");
    expect(output).toContain("tool_call_duration_seconds_sum 3.500000");
    expect(output).toContain("agent_turn_duration_seconds_count 2");
    expect(output).toContain("agent_turn_duration_seconds_sum 4.250000");
    expect(output).toContain('model_requests_total{result="succeeded"} 8');
    expect(output).toContain("channel_delivery_failures_total 4");
    expect(output).toMatch(/data_freshness_age_seconds\{shop_id="2255",data_type="SALES"\} 1\d\.\d{3}/);
    expect(output).toMatch(/data_freshness_age_seconds\{shop_id="2255",data_type="ORDERS"\} 2\d\.\d{3}/);
    expect(output).toContain('data_freshness_age_seconds{shop_id="2255",data_type="REFUNDS"} NaN');
    expect(output).toContain("metrics_collection_success 1");
    expect(database.prisma.toolRun.aggregate).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { name: { not: "__chat_turn__" } },
    }));
    expect(database.prisma.toolRun.aggregate).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { name: "__chat_turn__" },
    }));
  });

  it("keeps process metrics available when database aggregation fails", async () => {
    const database = { enabled: true, prisma: { $queryRawUnsafe: vi.fn().mockRejectedValue(new Error("offline")) } };
    const metrics = new MetricsService(database as never);
    metrics.observeHttp("POST", "/api/chat/turns", 503, 1);
    const output = await metrics.render();

    expect(output).toContain("http_requests_total");
    expect(output).toContain("metrics_collection_success 0");
    expect(output).not.toContain("offline");
  });
});
