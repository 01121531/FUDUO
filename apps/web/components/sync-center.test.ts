import { describe, expect, it } from "vitest";
import { formatDuration, groupRunItems, isRetryable, latestSuccessfulRun, type Run } from "./sync-center-model";

describe("synchronization center view model", () => {
  it("uses the latest completion time instead of list order", () => {
    const older = run({ id: "older", finishedAt: "2026-07-21T09:00:00.000Z" });
    const newer = run({ id: "newer", finishedAt: "2026-07-21T10:00:00.000Z" });
    expect(latestSuccessfulRun([older, newer])).toMatchObject({ id: "newer" });
  });

  it("formats minute boundaries without producing sixty seconds", () => {
    expect(formatDuration(119_600)).toBe("1 分 59 秒");
    expect(formatDuration(120_000)).toBe("2 分 0 秒");
  });

  it("only offers exact retry when the original date context is available", () => {
    expect(isRetryable(run({ status: "PARTIAL", payload: { tradeDate: "2026-07-21", shopIds: ["101"] } }))).toBe(true);
    expect(isRetryable(run({ status: "FAILED", payload: {} }))).toBe(false);
    expect(isRetryable(run({ status: "FAILED", errorCode: "ERP_REAUTH_REQUIRED", payload: { tradeDate: "2026-07-21" } }))).toBe(false);
  });

  it("groups item results by business date and data type", () => {
    const item = { id: "item-1", tradeDate: "2026-07-21", fuduoShopId: "101", shopName: "店铺 A", attempt: 1, errorCode: null, errorMessage: null, startedAt: "2026-07-21T08:00:00.000Z", finishedAt: "2026-07-21T08:00:01.000Z" };
    expect(groupRunItems([
      { ...item, dataType: "sales", status: "SUCCEEDED" },
      { ...item, id: "item-2", dataType: "sales", status: "FAILED", errorCode: "ERP_SHOP_UNAVAILABLE" },
      { ...item, id: "item-3", dataType: "orders", status: "SUCCEEDED" },
    ])).toEqual([{
      tradeDate: "2026-07-21",
      summaries: [
        { dataType: "sales", total: 2, success: 1, failed: 1 },
        { dataType: "orders", total: 1, success: 1, failed: 0 },
      ],
      failures: [expect.objectContaining({ id: "item-2", errorCode: "ERP_SHOP_UNAVAILABLE" })],
    }]);
  });
});

function run(overrides: Partial<Run>): Run {
  return {
    id: "run-1",
    type: "sales-live-sync",
    status: "SUCCEEDED",
    total: 1,
    success: 1,
    failed: 0,
    payload: { tradeDate: "2026-07-21" },
    createdAt: "2026-07-21T08:59:00.000Z",
    startedAt: "2026-07-21T08:59:30.000Z",
    finishedAt: "2026-07-21T09:00:00.000Z",
    durationMs: 30_000,
    ...overrides,
  };
}
