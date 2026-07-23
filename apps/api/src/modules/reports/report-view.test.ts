import { describe, expect, it } from "vitest";
import { buildWechatReportPreview, parseReportSnapshotData } from "./report-view.js";

describe("report snapshot view", () => {
  it("validates immutable report data and renders a deterministic WeChat preview", () => {
    const data = parseReportSnapshotData({
      period: { startDate: "2026-07-21", endDate: "2026-07-21" },
      shops: [{ shopId: 101, shopName: "测试店铺", salesAmount: 1200.5, transactionCount: 12, payBuyerCount: 11, refundAmount: 20, averageOrderValue: 100.04, freshness: "LIVE", dataAsOf: "2026-07-21T08:00:00.000Z" }],
      summary: { salesAmount: 1200.5, transactionCount: 12, payBuyerCount: 11, refundAmount: 20, averageOrderValue: 100.04 },
      freshness: "LIVE",
      dataAsOf: "2026-07-21T08:00:00.000Z",
      partial: false,
    });
    expect(data.shops[0]?.shopId).toBe("101");
    expect(data.shops[0]?.partial).toBe(false);
    expect(buildWechatReportPreview("DAILY", "2026-07-21", "2026-07-21", data)).toContain("测试店铺");
    expect(buildWechatReportPreview("DAILY", "2026-07-21", "2026-07-21", data)).toContain("数据截止");
    expect(buildWechatReportPreview("DAILY", "2026-07-21", "2026-07-21", data)).toContain("数据状态：实时（完整）");
  });

  it("warns WeChat recipients when a stale snapshot is partial", () => {
    const data = parseReportSnapshotData({
      period: { startDate: "2026-07-13", endDate: "2026-07-19" },
      shops: [],
      summary: { salesAmount: null, transactionCount: null, payBuyerCount: null, refundAmount: null, averageOrderValue: null },
      freshness: "STALE",
      dataAsOf: "2026-07-19T01:00:00.000Z",
      partial: true,
      missingShops: ["缺数店铺"],
    });

    const preview = buildWechatReportPreview("WEEKLY", "2026-07-13", "2026-07-19", data);
    expect(preview).toContain("数据状态：已过期（不完整）");
    expect(preview).toContain("数据截止：");
    expect(preview).toContain("缺失店铺：缺数店铺");
  });

  it("rejects malformed stored metrics instead of sending them to a channel", () => {
    expect(() => parseReportSnapshotData({ period: {}, shops: [], summary: {}, freshness: "LIVE", dataAsOf: null, partial: false })).toThrow();
  });
});
