import { describe, expect, it } from "vitest";
import type { SalesMetric } from "@fuduo/shared";
import { calculateChange, rankBySales, summarizeSales } from "./index";

const metrics: SalesMetric[] = [
  {
    shopId: 1,
    shopName: "店铺 A",
    tradeDate: "2026-07-21",
    salesAmount: 100,
    transactionCount: 4,
    payBuyerCount: 3,
    averageOrderValue: 25,
    refundAmount: 8,
    freshness: "LIVE",
    dataAsOf: "2026-07-21T08:00:00.000Z",
  },
  {
    shopId: 2,
    shopName: "店铺 B",
    tradeDate: "2026-07-21",
    salesAmount: null,
    transactionCount: null,
    payBuyerCount: null,
    averageOrderValue: null,
    refundAmount: null,
    freshness: "UNKNOWN",
    dataAsOf: "2026-07-21T08:00:00.000Z",
  },
];

describe("analytics", () => {
  it("keeps partial results explicit", () => {
    expect(summarizeSales(metrics)).toMatchObject({
      salesAmount: 100,
      transactionCount: 4,
      partial: true,
      missingShops: ["店铺 B"],
    });
  });

  it("ranks missing values last", () => {
    expect(rankBySales(metrics).map((item) => item.shopName)).toEqual(["店铺 A", "店铺 B"]);
  });

  it("does not invent a change when the denominator is zero", () => {
    expect(calculateChange(10, 0)).toBeNull();
  });

  it("sums currency using integer cents", () => {
    const result = summarizeSales([
      { ...metrics[0]!, salesAmount: 18_642.3, refundAmount: 642.8 },
      { ...metrics[0]!, shopId: 3, salesAmount: 15_480.2, refundAmount: 388.5 },
      { ...metrics[0]!, shopId: 4, salesAmount: 12_690.45, refundAmount: 521.2 },
      { ...metrics[0]!, shopId: 5, salesAmount: 8_642, refundAmount: 292 },
      { ...metrics[0]!, shopId: 6, salesAmount: 7_328.6, refundAmount: 165.8 },
    ]);
    expect(result.salesAmount).toBe(62_783.55);
    expect(result.refundAmount).toBe(2_010.3);
  });
});
