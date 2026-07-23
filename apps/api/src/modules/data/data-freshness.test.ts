import { describe, expect, it } from "vitest";
import { resolveDataFreshness, type PersistedDataSyncState } from "./data-freshness.js";

const now = new Date("2026-07-23T08:00:00.000Z");

describe("resolveDataFreshness", () => {
  it("keeps data types independent and uses the most conservative success time", () => {
    const result = resolveDataFreshness([
      state("SALES", "2026-07-23", "2026-07-23T07:55:00.000Z"),
      state("ORDERS", "2026-07-23", "2026-07-23T07:20:00.000Z"),
      state("REFUNDS", "2026-07-23", "2026-07-23T07:58:00.000Z"),
    ], ["SALES", "ORDERS", "REFUNDS"], "2026-07-23", "2026-07-23", now);

    expect(result.freshness).toBe("RECENT");
    expect(result.dataAsOf).toBe("2026-07-23T07:20:00.000Z");
    expect(result.freshnessByType.SALES?.freshness).toBe("LIVE");
    expect(result.freshnessByType.ORDERS?.freshness).toBe("RECENT");
  });

  it("forces stale after a failed attempt without discarding the previous success", () => {
    const failed = state("SALES", "2026-07-23", "2026-07-23T07:55:00.000Z");
    failed.lastAttemptAt = new Date("2026-07-23T07:59:00.000Z");
    failed.lastAttemptStatus = "FAILED";
    failed.errorCode = "UPSTREAM_BUSY";
    const result = resolveDataFreshness([failed], ["SALES"], "2026-07-23", "2026-07-23", now);

    expect(result).toMatchObject({ freshness: "STALE", partial: true, dataAsOf: "2026-07-23T07:55:00.000Z" });
    expect(result.freshnessByType.SALES).toMatchObject({ errorCode: "UPSTREAM_BUSY", lastAttemptAt: "2026-07-23T07:59:00.000Z" });
  });

  it("marks a range partial and unknown when any required business day is missing", () => {
    const result = resolveDataFreshness([
      state("REFUNDS", "2026-07-22", "2026-07-23T07:58:00.000Z"),
    ], ["REFUNDS"], "2026-07-22", "2026-07-23", now);

    expect(result).toMatchObject({ freshness: "UNKNOWN", partial: true });
  });

  it("uses today's successful sync time for a complete multi-day range", () => {
    const result = resolveDataFreshness([
      state("SALES", "2026-07-21", "2026-07-21T15:00:00.000Z"),
      state("SALES", "2026-07-22", "2026-07-22T15:00:00.000Z"),
      state("SALES", "2026-07-23", "2026-07-23T07:55:00.000Z"),
    ], ["SALES"], "2026-07-21", "2026-07-23", now);

    expect(result).toMatchObject({
      freshness: "LIVE",
      partial: false,
      dataAsOf: "2026-07-23T07:55:00.000Z",
    });
  });

  it("treats a complete historical range as available without aging it by fetch time", () => {
    const result = resolveDataFreshness([
      state("ORDERS", "2026-07-21", "2026-07-21T15:00:00.000Z"),
      state("ORDERS", "2026-07-22", "2026-07-22T15:00:00.000Z"),
    ], ["ORDERS"], "2026-07-21", "2026-07-22", now);

    expect(result).toMatchObject({
      freshness: "LIVE",
      partial: false,
      dataAsOf: "2026-07-22T15:00:00.000Z",
    });
  });
});

function state(dataType: string, tradeDate: string, successAt: string): PersistedDataSyncState {
  return {
    dataType,
    tradeDate: new Date(`${tradeDate}T00:00:00.000Z`),
    lastSuccessAt: new Date(successAt),
    lastAttemptAt: new Date(successAt),
    lastAttemptStatus: "SUCCEEDED",
    source: `FUDUO_${dataType}`,
    partial: false,
    errorCode: null,
  };
}
