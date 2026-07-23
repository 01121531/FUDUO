export interface ReportBusinessPeriod {
  startDate: string;
  endDate: string;
  dates: string[];
}

export type ReportDataset = "SALES" | "ORDERS" | "REFUNDS";
export const REPORT_REFRESH_MAX_AGE_MS = 60 * 60 * 1_000;

export interface ReportRefreshGroup {
  dataset: ReportDataset;
  tradeDate: string;
  shopIds: string[];
  reason: "MISSING" | "STALE";
}

export interface ReportRefreshPlan {
  period: ReportBusinessPeriod;
  groups: ReportRefreshGroup[];
}

export interface ReportRefreshResult {
  total: number;
  success: number;
  failed: number;
  failedGroups: ReportRefreshGroup[];
}

interface DatasetSyncResult { total: number; success: number; failed: number }
interface ReportDatasetSyncers {
  SALES(tradeDate: string, shopIds: string[]): Promise<DatasetSyncResult>;
  ORDERS(tradeDate: string, shopIds: string[]): Promise<DatasetSyncResult>;
  REFUNDS(tradeDate: string, shopIds: string[]): Promise<DatasetSyncResult>;
}

/** Runs all requested datasets and keeps going so a partial report can still be produced. */
export async function refreshReportDataGroups(
  groups: ReportRefreshGroup[],
  syncers: ReportDatasetSyncers,
): Promise<ReportRefreshResult> {
  const result: ReportRefreshResult = { total: 0, success: 0, failed: 0, failedGroups: [] };
  for (const group of groups) {
    try {
      const current = await syncers[group.dataset](group.tradeDate, group.shopIds);
      result.total += current.total;
      result.success += current.success;
      result.failed += current.failed;
      if (current.failed > 0) result.failedGroups.push(group);
    } catch {
      // At least one item per requested shop was not refreshed. The caller marks
      // the generated snapshot/run partial instead of dropping the whole report.
      result.total += group.shopIds.length;
      result.failed += group.shopIds.length;
      result.failedGroups.push(group);
    }
  }
  return result;
}

export interface MissingReportSales {
  period: ReportBusinessPeriod;
  missing: Array<{ tradeDate: string; shopIds: string[] }>;
}

/**
 * Finds report inputs which cannot safely be used as a completed-period
 * snapshot. Each report depends on sales, order and refund aggregates. A row
 * is refreshed when it is absent or when it predates the freshness cutoff.
 */
export async function findReportRefreshPlan(
  source: ReportDataSource,
  type: "DAILY" | "WEEKLY",
  requestedShopIds: string[] | undefined,
  now = new Date(),
  maxAgeMs = REPORT_REFRESH_MAX_AGE_MS,
  freshnessNow = now,
): Promise<ReportRefreshPlan> {
  const period = reportBusinessPeriod(type, now);
  const shops = await source.shop.findMany({
    where: {
      status: "ACTIVE",
      ...(requestedShopIds?.length ? { fuduoShopId: { in: requestedShopIds.map(BigInt) } } : {}),
    },
    select: { id: true, fuduoShopId: true },
  });
  if (!shops.length) return { period, groups: [] };

  const query = {
    where: {
      shopId: { in: shops.map((shop) => shop.id) },
      tradeDate: { gte: dbDate(period.startDate), lte: dbDate(period.endDate) },
    },
    select: { shopId: true, tradeDate: true, fetchedAt: true } as const,
  };
  const [sales, orders, refunds, states] = await Promise.all([
    source.salesDaily.findMany(query),
    source.orderDaily.findMany(query),
    source.refundDaily.findMany(query),
    source.dataSyncState?.findMany({
      where: {
        shopId: { in: shops.map((shop) => shop.id) },
        dataType: { in: ["sales", "orders", "refunds"] },
        tradeDate: { gte: dbDate(period.startDate), lte: dbDate(period.endDate) },
      },
      select: { shopId: true, dataType: true, tradeDate: true, lastSuccessAt: true, lastAttemptStatus: true, partial: true },
    }) ?? Promise.resolve([]),
  ]);
  const staleBefore = new Date(freshnessNow.getTime() - maxAgeMs);
  const stateByTypeShopAndDate = new Map(states.map((state) => [
    `${state.dataType.toUpperCase()}:${state.shopId}:${dayKey(state.tradeDate)}`,
    state,
  ]));
  const datasets: Array<[ReportDataset, ReportDataRow[]]> = [
    ["SALES", sales],
    ["ORDERS", orders],
    ["REFUNDS", refunds],
  ];
  const groups: ReportRefreshGroup[] = [];
  for (const [dataset, rows] of datasets) {
    const byShopAndDate = new Map(rows.map((row) => [`${row.shopId}:${dayKey(row.tradeDate)}`, row]));
    for (const tradeDate of period.dates) {
      const missing: string[] = [];
      const stale: string[] = [];
      for (const shop of shops) {
        const row = byShopAndDate.get(`${shop.id}:${tradeDate}`);
        if (!row) missing.push(String(shop.fuduoShopId));
        else {
          const state = stateByTypeShopAndDate.get(`${dataset}:${shop.id}:${tradeDate}`);
          const stateIsStale = state
            ? state.lastAttemptStatus !== "SUCCEEDED" || state.partial || !state.lastSuccessAt || state.lastSuccessAt < staleBefore
            : row.fetchedAt < staleBefore;
          if (stateIsStale) stale.push(String(shop.fuduoShopId));
        }
      }
      if (missing.length) groups.push({ dataset, tradeDate, shopIds: missing, reason: "MISSING" });
      if (stale.length) groups.push({ dataset, tradeDate, shopIds: stale, reason: "STALE" });
    }
  }
  return { period, groups };
}

/** Compatibility wrapper retained for callers that only inspect sales gaps. */
export async function findMissingReportSales(
  source: ReportDataSource,
  type: "DAILY" | "WEEKLY",
  requestedShopIds: string[] | undefined,
  now = new Date(),
): Promise<MissingReportSales> {
  const plan = await findReportRefreshPlan(source, type, requestedShopIds, now, Number.POSITIVE_INFINITY);
  return {
    period: plan.period,
    missing: plan.groups
      .filter((group) => group.dataset === "SALES" && group.reason === "MISSING")
      .map(({ tradeDate, shopIds }) => ({ tradeDate, shopIds })),
  };
}

export function reportBusinessPeriod(type: "DAILY" | "WEEKLY", now = new Date()): ReportBusinessPeriod {
  const today = shanghaiDate(now);
  if (type === "DAILY") {
    const date = addDays(today, -1);
    return { startDate: date, endDate: date, dates: [date] };
  }
  const current = dbDate(today);
  const day = current.getUTCDay() || 7;
  const startDate = addDays(today, -day - 6);
  const dates = Array.from({ length: 7 }, (_, index) => addDays(startDate, index));
  return { startDate, endDate: dates[6]!, dates };
}

interface ReportDataRow { shopId: string; tradeDate: Date; fetchedAt: Date }

interface DailyDataSource {
  findMany(args: {
    where: { shopId: { in: string[] }; tradeDate: { gte: Date; lte: Date } };
    select: { shopId: true; tradeDate: true; fetchedAt: true };
  }): Promise<ReportDataRow[]>;
}

interface ReportDataSource {
  shop: {
    findMany(args: {
      where: { status: "ACTIVE"; fuduoShopId?: { in: bigint[] } };
      select: { id: true; fuduoShopId: true };
    }): Promise<Array<{ id: string; fuduoShopId: bigint }>>;
  };
  salesDaily: DailyDataSource;
  orderDaily: DailyDataSource;
  refundDaily: DailyDataSource;
  dataSyncState?: {
    findMany(args: {
      where: {
        shopId: { in: string[] };
        dataType: { in: string[] };
        tradeDate: { gte: Date; lte: Date };
      };
      select: { shopId: true; dataType: true; tradeDate: true; lastSuccessAt: true; lastAttemptStatus: true; partial: true };
    }): Promise<Array<{
      shopId: string;
      dataType: string;
      tradeDate: Date;
      lastSuccessAt: Date | null;
      lastAttemptStatus: string;
      partial: boolean;
    }>>;
  };
}

function shanghaiDate(now: Date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
function dbDate(value: string) { return new Date(`${value}T00:00:00.000Z`); }
function dayKey(value: Date) { return value.toISOString().slice(0, 10); }
function addDays(value: string, days: number) { const result = dbDate(value); result.setUTCDate(result.getUTCDate() + days); return dayKey(result); }
