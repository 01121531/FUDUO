import { describe, expect, it, vi } from "vitest";
import { ReportDeliveryService } from "./report-delivery.service.js";

const id = "550e8400-e29b-41d4-a716-446655440000";

describe("ReportDeliveryService", () => {
  it("claims, authorizes, renders and completes a queued WeChat delivery", async () => {
    const delivery = record();
    const reportDelivery = {
      findUnique: vi.fn()
        .mockResolvedValueOnce({ id, status: "QUEUED", attempts: 0, externalMessageId: null, leaseExpiresAt: null })
        .mockResolvedValueOnce(delivery)
        .mockResolvedValueOnce({ id, status: "SUCCEEDED", attempts: 1, externalMessageId: "message-1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const database = db(reportDelivery, [{ userId: "user-1" }]);
    const access = { scope: vi.fn(async () => ({ permissions: ["reports:read"], allShops: false, shopIds: ["101"] })) };
    const openClaw = { send: vi.fn(async () => ({ messageId: "message-1" })) };

    const result = await new ReportDeliveryService(database as never, access as never, openClaw as never).execute(id);

    expect(openClaw.send).toHaveBeenCalledWith("employee@im.wechat", expect.stringContaining("测试店铺"), id);
    expect(reportDelivery.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id, OR: expect.any(Array) }),
      data: expect.objectContaining({ status: "SENDING", attempts: { increment: 1 }, leaseToken: expect.any(String), leaseExpiresAt: expect.any(Date) }),
    }));
    const leaseToken = reportDelivery.updateMany.mock.calls[0]![0].data.leaseToken as string;
    expect(reportDelivery.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id, status: "SENDING", leaseToken },
      data: { leaseExpiresAt: expect.any(Date) },
    });
    expect(reportDelivery.updateMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
      where: { id, status: "SENDING", leaseToken },
      data: expect.objectContaining({ status: "SUCCEEDED", externalMessageId: "message-1", leaseToken: null, leaseExpiresAt: null }),
    }));
    expect(result).toMatchObject({ id, status: "SUCCEEDED", attempts: 1, idempotent: false, externalMessageId: "message-1" });
  });

  it("does not resend deliveries already succeeded or left in an uncertain sending state", async () => {
    for (const status of ["SUCCEEDED", "SENDING"]) {
      const reportDelivery = { findUnique: vi.fn(async () => ({ id, status, attempts: 1, externalMessageId: status === "SUCCEEDED" ? "message-1" : null, leaseExpiresAt: status === "SENDING" ? new Date(Date.now() + 60_000) : null })) };
      const openClaw = { send: vi.fn() };
      const result = await new ReportDeliveryService(db(reportDelivery) as never, {} as never, openClaw as never).execute(id);
      expect(result).toMatchObject({ status, idempotent: true });
      expect(openClaw.send).not.toHaveBeenCalled();
    }
  });

  it("fails before sending when the recipient no longer has the complete report shop scope", async () => {
    const reportDelivery = {
      findUnique: vi.fn()
        .mockResolvedValueOnce({ id, status: "QUEUED", attempts: 0, externalMessageId: null, leaseExpiresAt: null })
        .mockResolvedValueOnce(record()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const database = db(reportDelivery, [{ userId: "user-1" }]);
    const access = { scope: vi.fn(async () => ({ permissions: ["reports:read"], allShops: false, shopIds: ["202"] })) };
    const openClaw = { send: vi.fn() };

    await expect(new ReportDeliveryService(database as never, access as never, openClaw as never).execute(id)).rejects.toThrow("REPORT_DELIVERY_FORBIDDEN");
    expect(openClaw.send).not.toHaveBeenCalled();
    expect(reportDelivery.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id, status: "SENDING", leaseToken: expect.any(String) },
      data: { status: "FAILED", errorCode: "REPORT_DELIVERY_FORBIDDEN", leaseToken: null, leaseExpiresAt: null },
    });
  });

  it("leaves an uncertain send in SENDING so a retry cannot duplicate the message", async () => {
    const reportDelivery = {
      findUnique: vi.fn()
        .mockResolvedValueOnce({ id, status: "QUEUED", attempts: 0, externalMessageId: null, leaseExpiresAt: null })
        .mockResolvedValueOnce(record()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const openClaw = { send: vi.fn(async () => { throw new Error("WECHAT_DELIVERY_FAILED"); }) };
    const service = new ReportDeliveryService(
      db(reportDelivery, [{ userId: "user-1" }]) as never,
      { scope: vi.fn(async () => ({ permissions: ["*"], allShops: true, shopIds: [] })) } as never,
      openClaw as never,
    );

    await expect(service.execute(id)).rejects.toThrow("REPORT_DELIVERY_UNCERTAIN");
    expect(reportDelivery.updateMany).toHaveBeenCalledTimes(2);
    expect(reportDelivery.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: expect.objectContaining({ leaseToken: expect.any(String) }) }));
  });

  it("reclaims an expired sending lease after a crashed worker", async () => {
    const reportDelivery = {
      findUnique: vi.fn()
        .mockResolvedValueOnce({ id, status: "SENDING", attempts: 1, externalMessageId: null, leaseExpiresAt: new Date(Date.now() - 60_000) })
        .mockResolvedValueOnce(record())
        .mockResolvedValueOnce({ id, status: "SUCCEEDED", attempts: 2, externalMessageId: "message-2" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const service = new ReportDeliveryService(
      db(reportDelivery, [{ userId: "user-1" }]) as never,
      { scope: vi.fn(async () => ({ permissions: ["*"], allShops: true, shopIds: [] })) } as never,
      { send: vi.fn(async () => ({ messageId: "message-2" })) } as never,
    );

    await expect(service.execute(id)).resolves.toMatchObject({ status: "SUCCEEDED", attempts: 2 });
    expect(reportDelivery.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id, OR: expect.arrayContaining([expect.objectContaining({ status: "SENDING" })]) }),
    }));
  });

  it("does not send when another worker wins the atomic claim", async () => {
    const reportDelivery = {
      findUnique: vi.fn()
        .mockResolvedValueOnce({ id, status: "QUEUED", attempts: 0, externalMessageId: null, leaseExpiresAt: null })
        .mockResolvedValueOnce({ id, status: "SENDING", attempts: 1, externalMessageId: null }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    };
    const openClaw = { send: vi.fn() };
    await expect(new ReportDeliveryService(db(reportDelivery) as never, {} as never, openClaw as never).execute(id))
      .resolves.toMatchObject({ status: "SENDING", idempotent: true });
    expect(openClaw.send).not.toHaveBeenCalled();
  });
});

function db(reportDelivery: object, pairings: Array<{ userId: string }> = []) {
  return {
    enabled: true,
    prisma: {
      reportDelivery,
      channelUser: { findMany: vi.fn(async () => pairings) },
    },
  };
}

function record() {
  return {
    id,
    channel: "WECHAT",
    recipient: "employee@im.wechat",
    status: "SENDING",
    attempts: 1,
    externalMessageId: null,
    reportSnapshot: {
      type: "DAILY",
      periodStart: new Date("2026-07-21T00:00:00.000Z"),
      periodEnd: new Date("2026-07-21T00:00:00.000Z"),
      shopIds: ["101"],
      data: {
        period: { startDate: "2026-07-21", endDate: "2026-07-21" },
        shops: [{ shopId: "101", shopName: "测试店铺", salesAmount: 1200, transactionCount: 12, payBuyerCount: 11, refundAmount: 20, averageOrderValue: 100, freshness: "LIVE", dataAsOf: "2026-07-21T08:00:00.000Z", missing: false }],
        summary: { salesAmount: 1200, transactionCount: 12, payBuyerCount: 11, refundAmount: 20, averageOrderValue: 100 },
        freshness: "LIVE",
        dataAsOf: "2026-07-21T08:00:00.000Z",
        partial: false,
        missingShops: [],
      },
    },
  };
}
