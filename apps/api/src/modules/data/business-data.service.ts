import { Inject, Injectable } from "@nestjs/common";
import { calculateFreshness, type Freshness, type SalesMetric, type Shop } from "@fuduo/shared";
import { calculateChange, rankBySales, summarizeSales } from "@fuduo/analytics";
import { DatabaseService } from "../database/database.service.js";
import { DemoDataService } from "../demo/demo-data.service.js";
import { addBusinessDays, businessDateAsUtc, resolveDashboardRange, shanghaiBusinessDate, toBusinessDateKey, type DashboardPeriod, type DashboardRange } from "./dashboard-period.js";
import { resolveDataFreshness } from "./data-freshness.js";

@Injectable()
export class BusinessDataService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(DemoDataService) private readonly demo: DemoDataService,
  ) {}

  async listShops(allowedShopIds: string[] | null = null): Promise<Shop[]> {
    if (!this.database.enabled) return allowedShopIds === null ? this.demo.shops : this.demo.shops.filter((shop) => allowedShopIds.includes(String(shop.id)));
    const tradeDate = businessDateAsUtc(shanghaiBusinessDate());
    const rows = await this.database.prisma.shop.findMany({
      where: { status: { not: "ARCHIVED" }, ...(allowedShopIds !== null ? { fuduoShopId: { in: allowedShopIds.map(BigInt) } } : {}) },
      include: {
        salesDaily: { where: { tradeDate }, take: 1 },
        refundDaily: { where: { tradeDate }, take: 1 },
        dataSyncStates: { where: { tradeDate, dataType: { in: ["sales", "orders", "refunds"] } } },
      },
      orderBy: { name: "asc" },
    });
    return rows.map((row) => {
      const sales = row.salesDaily[0];
      const refunds = row.refundDaily[0];
      const sync = resolveDataFreshness(row.dataSyncStates ?? [], ["SALES", "ORDERS", "REFUNDS"], shanghaiBusinessDate(), shanghaiBusinessDate());
      return {
        id: safeExternalId(row.fuduoShopId),
        accountId: row.fuduoAccountId ? safeExternalId(row.fuduoAccountId) : null,
        name: row.name,
        platform: row.platformCode,
        loginStatus: row.loginStatus,
        todaySales: sales?.salesAmount?.toNumber() ?? null,
        todayOrders: sales?.transactionCount ?? null,
        refundAmount: refunds?.refundAmount?.toNumber() ?? null,
        lastSyncedAt: sync.dataAsOf,
        freshness: sync.freshness,
        dataAsOf: sync.dataAsOf,
        lastAttemptAt: sync.lastAttemptAt,
        source: sync.source,
        partial: sync.partial,
      };
    });
  }

  async shopDetail(externalId: string, allowedShopIds: string[] | null = null) {
    if (allowedShopIds !== null && !allowedShopIds.includes(externalId)) return null;
    if (!this.database.enabled) {
      const shop = this.demo.shops.find((item) => item.id === Number(externalId));
      if (!shop) return null;
      return { shop, sales: this.demo.sales.find((item) => item.shopId === shop.id) ?? null, trend: this.demo.trend };
    }
    const fuduoShopId = parseExternalId(externalId);
    const end = shanghaiBusinessDate();
    const start = addBusinessDays(end, -6);
    const row = await this.database.prisma.shop.findUnique({
      where: { fuduoShopId },
      include: {
        salesDaily: {
          where: { tradeDate: { gte: businessDateAsUtc(start), lte: businessDateAsUtc(end) } },
          orderBy: { tradeDate: "asc" },
        },
        refundDaily: {
          where: { tradeDate: { gte: businessDateAsUtc(start), lte: businessDateAsUtc(end) } },
          orderBy: { tradeDate: "asc" },
        },
        dataSyncStates: {
          where: { tradeDate: { gte: businessDateAsUtc(start), lte: businessDateAsUtc(end) }, dataType: { in: ["sales", "refunds"] } },
        },
      },
    });
    if (!row) return null;
    const today = businessDateAsUtc(end).getTime();
    const todaySales = row.salesDaily.find((item) => item.tradeDate.getTime() === today);
    const todayRefund = row.refundDaily.find((item) => item.tradeDate.getTime() === today);
    const shop: Shop = {
      id: safeExternalId(row.fuduoShopId),
      accountId: row.fuduoAccountId ? safeExternalId(row.fuduoAccountId) : null,
      name: row.name,
      platform: row.platformCode,
      loginStatus: row.loginStatus,
      todaySales: todaySales?.salesAmount?.toNumber() ?? null,
      todayOrders: todaySales?.transactionCount ?? null,
      refundAmount: todayRefund?.refundAmount?.toNumber() ?? null,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    };
    const sales = todaySales ? toSalesMetric(row, todaySales, todayRefund?.refundAmount?.toNumber() ?? null) : null;
    const salesByDate = new Map(row.salesDaily.map((item) => [toBusinessDateKey(item.tradeDate), item.salesAmount?.toNumber() ?? null]));
    const trend = Array.from({ length: 7 }, (_, index) => {
      const date = addBusinessDays(start, index);
      return { date: date.slice(5), sales: salesByDate.get(date) ?? null, previous: null };
    });
    return { shop, sales, trend };
  }

  async shopHistory(externalId: string, days = 30, allowedShopIds: string[] | null = null) {
    if (allowedShopIds !== null && !allowedShopIds.includes(externalId)) return null;
    const end = shanghaiBusinessDate();
    const start = addBusinessDays(end, 1 - days);
    if (!this.database.enabled) {
      const shop = this.demo.shops.find((item) => item.id === Number(externalId));
      if (!shop) return null;
      const metric = this.demo.sales.find((item) => item.shopId === shop.id);
      const demoStatus = {
        freshness: metric?.freshness ?? "UNKNOWN" as Freshness,
        lastSuccessAt: metric?.dataAsOf ?? null,
        lastAttemptAt: metric?.dataAsOf ?? null,
        source: metric ? "DEMO" : null,
        partial: !metric,
        errorCode: null,
      };
      return {
        shopId: externalId,
        range: { start, end, days },
        sales: metric ? [{ date: metric.tradeDate, salesAmount: metric.salesAmount, transactionCount: metric.transactionCount, payBuyerCount: metric.payBuyerCount, averageOrderValue: metric.averageOrderValue, refundAmount: metric.refundAmount, fetchedAt: metric.dataAsOf }] : [],
        orders: [],
        refunds: [],
        dataStatus: {
          SALES: demoStatus,
          ORDERS: { ...demoStatus, freshness: "UNKNOWN" as Freshness, partial: true },
          REFUNDS: { ...demoStatus, freshness: "UNKNOWN" as Freshness, partial: true },
        },
      };
    }
    const shop = await this.database.prisma.shop.findUnique({
      where: { fuduoShopId: parseExternalId(externalId) },
      include: {
        salesDaily: { where: { tradeDate: { gte: businessDateAsUtc(start), lte: businessDateAsUtc(end) } }, orderBy: { tradeDate: "desc" } },
        orderDaily: { where: { tradeDate: { gte: businessDateAsUtc(start), lte: businessDateAsUtc(end) } }, orderBy: { tradeDate: "desc" } },
        refundDaily: { where: { tradeDate: { gte: businessDateAsUtc(start), lte: businessDateAsUtc(end) } }, orderBy: { tradeDate: "desc" } },
        dataSyncStates: {
          where: {
            tradeDate: { gte: businessDateAsUtc(start), lte: businessDateAsUtc(end) },
            dataType: { in: ["sales", "orders", "refunds"] },
          },
        },
      },
    });
    if (!shop) return null;
    const syncStates = shop.dataSyncStates ?? [];
    const freshness = resolveDataFreshness(syncStates, ["SALES", "ORDERS", "REFUNDS"], start, end);
    return {
      shopId: externalId,
      range: { start, end, days },
      sales: shop.salesDaily.map((row) => ({
        date: toBusinessDateKey(row.tradeDate),
        salesAmount: row.salesAmount?.toNumber() ?? null,
        transactionCount: row.transactionCount,
        payBuyerCount: row.payBuyerCount,
        averageOrderValue: row.averageOrderValue?.toNumber() ?? null,
        refundAmount: shop.refundDaily.find((refund) => refund.tradeDate.getTime() === row.tradeDate.getTime())?.refundAmount?.toNumber() ?? null,
        fetchedAt: row.fetchedAt.toISOString(),
      })),
      orders: shop.orderDaily.map((row) => ({
        date: toBusinessDateKey(row.tradeDate),
        orderCount: row.orderCount,
        paidOrderCount: row.paidOrderCount,
        paidAmount: row.paidAmount?.toNumber() ?? null,
        fetchedAt: row.fetchedAt.toISOString(),
      })),
      refunds: shop.refundDaily.map((row) => ({
        date: toBusinessDateKey(row.tradeDate),
        refundCount: row.refundCount,
        refundAmount: row.refundAmount?.toNumber() ?? null,
        fetchedAt: row.fetchedAt.toISOString(),
      })),
      dataStatus: Object.fromEntries(["SALES", "ORDERS", "REFUNDS"].map((dataType) => {
        const states = syncStates.filter((state) => state.dataType.toUpperCase() === dataType);
        const latestSuccess = states.flatMap((state) => state.lastSuccessAt ? [state.lastSuccessAt] : [])
          .sort((left, right) => right.getTime() - left.getTime())[0];
        return [dataType, {
          ...freshness.freshnessByType[dataType as "SALES" | "ORDERS" | "REFUNDS"],
          lastSuccessAt: latestSuccess?.toISOString() ?? null,
        }];
      })),
    };
  }

  async dashboard(period: DashboardPeriod = "today", shopIds: string[] = [], rangeOverride?: DashboardRange, allowedShopIds: string[] | null = null) {
    const range = rangeOverride ?? resolveDashboardRange(period);
    if (range.period !== period) throw new Error("DASHBOARD_RANGE_PERIOD_MISMATCH");
    const effectiveShopIds = allowedShopIds === null ? shopIds : shopIds.length ? shopIds : allowedShopIds;
    if (!this.database.enabled) return this.demo.dashboard(range, effectiveShopIds);
    const shops = await this.database.prisma.shop.findMany({
      where: {
        status: "ACTIVE",
        ...(allowedShopIds !== null || effectiveShopIds.length ? { fuduoShopId: { in: effectiveShopIds.map((id) => BigInt(id)) } } : {}),
      },
      include: {
        salesDaily: {
          where: { tradeDate: { gte: businessDateAsUtc(range.previousStart), lte: businessDateAsUtc(range.end) } },
          orderBy: { tradeDate: "asc" },
        },
        refundDaily: {
          where: { tradeDate: { gte: businessDateAsUtc(range.previousStart), lte: businessDateAsUtc(range.end) } },
          orderBy: { tradeDate: "asc" },
        },
        dataSyncStates: {
          where: { tradeDate: { gte: businessDateAsUtc(range.previousStart), lte: businessDateAsUtc(range.end) }, dataType: { in: ["sales", "refunds"] } },
        },
      },
      orderBy: { name: "asc" },
    });
    const metrics = shops.map((shop) => aggregatePeriod(shop, range.start, range.end));
    const previousMetrics = shops.map((shop) => aggregatePeriod(shop, range.previousStart, range.previousEnd));
    const summary = dashboardSummary(metrics);
    const previousSummary = dashboardSummary(previousMetrics);
    const dataAsOf = oldestIso(metrics.map((metric) => new Date(metric.dataAsOf)));
    const freshness = worstFreshness(metrics.map((metric) => metric.freshness));
    return {
      period,
      range,
      summary,
      changes: summaryChanges(summary, previousSummary),
      rankings: rankBySales(metrics),
      trend: buildTrend(shops, range),
      freshness,
      dataAsOf,
      alerts: [
        ...metrics
        .filter((metric) => metric.freshness === "STALE" || metric.freshness === "UNKNOWN" || metric.salesAmount === null)
        .map((metric) => ({
          id: `freshness-${metric.shopId}`,
          level: "warning",
          title: `${metric.shopName}数据${metric.salesAmount === null || metric.freshness === "UNKNOWN" ? "尚未同步" : "已过期"}`,
          detail: metric.salesAmount === null || metric.freshness === "UNKNOWN" ? `${range.label}没有可用销售数据` : `最后成功同步：${new Date(metric.dataAsOf).toLocaleString("zh-CN")}`,
        })),
        ...metrics
          .filter((metric) => metric.refundAmount === null)
          .map((metric) => ({
            id: `refund-${metric.shopId}`,
            level: "warning",
            title: `${metric.shopName}退款数据不完整`,
            detail: `${range.label}缺少一个或多个业务日的退款数据`,
          })),
      ],
    };
  }

  async syncRuns(allowedShopIds: string[] | null = null) {
    const runs = !this.database.enabled
      ? this.demo.syncRuns()
      : (await this.database.prisma.syncRun.findMany({ orderBy: { createdAt: "desc" }, take: allowedShopIds === null ? 50 : 200 })).map(toSyncRun);
    return runs
      .map((run) => scopeSyncRun(run, allowedShopIds))
      .filter((run): run is NonNullable<typeof run> => run !== null)
      .slice(0, 50);
  }

  async syncRun(id: string, allowedShopIds: string[] | null = null) {
    if (!this.database.enabled) {
      const run = this.demo.syncRuns().find((item) => item.id === id);
      return run ? scopeSyncRun(run, allowedShopIds) : null;
    }
    const run = await this.database.prisma.syncRun.findUnique({
      where: { id },
      include: { items: { orderBy: [{ tradeDate: "desc" }, { dataType: "asc" }, { shopName: "asc" }] } },
    });
    return run ? scopeSyncRun(toSyncRun(run), allowedShopIds) : null;
  }
}

function scopeSyncRun<T extends { payload: { shopIds?: string[] }; items?: SyncRunItemView[]; total: number; success: number; failed: number }>(run: T, allowedShopIds: string[] | null): (T & { scopeAllShops: boolean }) | null {
  const original = run.payload.shopIds;
  if (allowedShopIds === null) return { ...run, scopeAllShops: !original?.length };
  if (!allowedShopIds.length) return null;
  const items = run.items?.filter((item) => allowedShopIds.includes(item.fuduoShopId));
  const visibleCounts = items?.length ? {
    total: items.length,
    success: items.filter((item) => item.status === "SUCCEEDED").length,
    failed: items.filter((item) => item.status === "FAILED").length,
  } : {};
  if (original?.length) {
    const shopIds = original.filter((id) => allowedShopIds.includes(id));
    if (!shopIds.length) return null;
    return { ...run, ...visibleCounts, ...(items ? { items } : {}), payload: { ...run.payload, shopIds }, scopeAllShops: false };
  }
  return { ...run, ...visibleCounts, ...(items ? { items } : {}), payload: { ...run.payload, shopIds: allowedShopIds }, scopeAllShops: false };
}

type SyncRunItemView = ReturnType<typeof toSyncRunItem>;

function toSyncRun(run: {
  id: string;
  type: string;
  status: string;
  requestedBy: string | null;
  totalItems: number;
  successItems: number;
  failedItems: number;
  errorCode: string | null;
  errorMessage: string | null;
  payload: unknown;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  items?: Array<{
    id: string;
    dataType: string;
    tradeDate: Date;
    fuduoShopId: bigint;
    shopName: string;
    status: string;
    attempt: number;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: Date;
    finishedAt: Date | null;
  }>;
}) {
  return {
    id: run.id,
    type: run.type,
    status: run.status,
    requestedBy: run.requestedBy,
    total: run.totalItems,
    success: run.successItems,
    failed: run.failedItems,
    payload: normalizeSyncPayload(run.payload),
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    durationMs: run.startedAt && run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    ...(run.items ? { items: run.items.map(toSyncRunItem) } : {}),
  };
}

function toSyncRunItem(item: {
  id: string;
  dataType: string;
  tradeDate: Date;
  fuduoShopId: bigint;
  shopName: string;
  status: string;
  attempt: number;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}) {
  return {
    id: item.id,
    dataType: item.dataType,
    tradeDate: toBusinessDateKey(item.tradeDate),
    fuduoShopId: item.fuduoShopId.toString(),
    shopName: item.shopName,
    status: item.status,
    attempt: item.attempt,
    errorCode: item.errorCode,
    errorMessage: item.errorMessage,
    startedAt: item.startedAt.toISOString(),
    finishedAt: item.finishedAt?.toISOString() ?? null,
  };
}

function normalizeSyncPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const tradeDate = typeof input.tradeDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.tradeDate) ? input.tradeDate : undefined;
  const tradeDates = Array.isArray(input.tradeDates)
    ? input.tradeDates.filter((item): item is string => typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item)).slice(0, 31)
    : undefined;
  const shopIds = Array.isArray(input.shopIds)
    ? input.shopIds.filter((item): item is string => typeof item === "string" && /^\d{1,19}$/.test(item)).slice(0, 50)
    : undefined;
  const sourceRunId = typeof input.sourceRunId === "string" && /^[0-9a-f-]{36}$/i.test(input.sourceRunId) ? input.sourceRunId : undefined;
  return {
    ...(tradeDate ? { tradeDate } : {}),
    ...(tradeDates?.length ? { tradeDates } : {}),
    ...(shopIds?.length ? { shopIds } : {}),
    ...(sourceRunId ? { sourceRunId } : {}),
  };
}

type DatabaseShop = Awaited<ReturnType<BusinessDataService["database"]["prisma"]["shop"]["findFirst"]>>;

function toSalesMetric(
  shop: NonNullable<DatabaseShop>,
  daily: {
    tradeDate: Date;
    salesAmount: { toNumber(): number } | null;
    transactionCount: number | null;
    payBuyerCount: number | null;
    averageOrderValue: { toNumber(): number } | null;
    refundAmount: { toNumber(): number } | null;
    fetchedAt: Date;
  },
  refundAmount = daily.refundAmount?.toNumber() ?? null,
): SalesMetric {
  return {
    shopId: safeExternalId(shop.fuduoShopId),
    shopName: shop.name,
    tradeDate: toBusinessDateKey(daily.tradeDate),
    salesAmount: daily.salesAmount?.toNumber() ?? null,
    transactionCount: daily.transactionCount,
    payBuyerCount: daily.payBuyerCount,
    averageOrderValue: daily.averageOrderValue?.toNumber() ?? null,
    refundAmount,
    freshness: calculateFreshness(daily.fetchedAt),
    dataAsOf: daily.fetchedAt.toISOString(),
  };
}

function parseExternalId(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error("Invalid shop ID");
  return BigInt(value);
}

function safeExternalId(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted)) throw new Error("External shop ID exceeds JavaScript safe integer range");
  return converted;
}

function oldestIso(values: Array<Date | null>): string {
  const timestamps = values.filter((value): value is Date => value !== null).map((value) => value.getTime());
  return timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : new Date(0).toISOString();
}

function worstFreshness(values: Freshness[]): Freshness {
  if (!values.length) return "UNKNOWN";
  const order: Freshness[] = ["LIVE", "RECENT", "STALE", "UNKNOWN"];
  return values.reduce((worst, value) => order.indexOf(value) > order.indexOf(worst) ? value : worst, "LIVE");
}

type PeriodShop = {
  fuduoShopId: bigint;
  name: string;
  lastSyncedAt: Date | null;
  salesDaily: Array<{
    tradeDate: Date;
    salesAmount: { toNumber(): number } | null;
    transactionCount: number | null;
    payBuyerCount: number | null;
    averageOrderValue: { toNumber(): number } | null;
    refundAmount: { toNumber(): number } | null;
    fetchedAt: Date;
  }>;
  refundDaily: Array<{
    tradeDate: Date;
    refundAmount: { toNumber(): number } | null;
    fetchedAt: Date;
  }>;
  dataSyncStates: Array<{
    dataType: string;
    tradeDate: Date;
    lastSuccessAt: Date | null;
    lastAttemptAt: Date;
    lastAttemptStatus: string;
    source: string | null;
    partial: boolean;
    errorCode: string | null;
  }>;
};

type EnrichedSalesMetric = SalesMetric & {
  lastAttemptAt: string | null;
  source: string | null;
  partial: boolean;
  freshnessByType: ReturnType<typeof resolveDataFreshness>["freshnessByType"];
};

function aggregatePeriod(shop: PeriodShop, start: string, end: string): EnrichedSalesMetric {
  const rows = shop.salesDaily.filter((row) => {
    const date = toBusinessDateKey(row.tradeDate);
    return date >= start && date <= end;
  });
  const fetchedAt = rows.length ? new Date(Math.max(...rows.map((row) => row.fetchedAt.getTime()))) : shop.lastSyncedAt;
  const validSales = rows.map((row) => row.salesAmount?.toNumber() ?? null).filter((value): value is number => value !== null);
  const refundRows = shop.refundDaily.filter((row) => {
    const date = toBusinessDateKey(row.tradeDate);
    return date >= start && date <= end;
  });
  const refundFetchedAt = refundRows.length ? new Date(Math.max(...refundRows.map((row) => row.fetchedAt.getTime()))) : null;
  const expectedDays = daysBetween(start, end) + 1;
  const completeRows = rows.length === expectedDays && new Set(rows.map((row) => toBusinessDateKey(row.tradeDate))).size === expectedDays;
  const completeRefundRows = refundRows.length === expectedDays && new Set(refundRows.map((row) => toBusinessDateKey(row.tradeDate))).size === expectedDays;
  const sync = resolveDataFreshness(shop.dataSyncStates ?? [], ["SALES", "REFUNDS"], start, end);
  const salesAmount = completeRows && validSales.length === rows.length ? sumMoney(validSales) : null;
  const transactionCount = completeRows && rows.every((row) => row.transactionCount !== null)
    ? rows.reduce((sum, row) => sum + row.transactionCount!, 0)
    : null;
  return {
    shopId: safeExternalId(shop.fuduoShopId),
    shopName: shop.name,
    tradeDate: start === end ? end : `${start}/${end}`,
    salesAmount,
    transactionCount,
    payBuyerCount: completeRows && rows.every((row) => row.payBuyerCount !== null)
      ? rows.reduce((sum, row) => sum + row.payBuyerCount!, 0)
      : null,
    averageOrderValue: salesAmount !== null && transactionCount !== null && transactionCount > 0 ? Math.round((salesAmount / transactionCount) * 100) / 100 : null,
    refundAmount: completeRefundRows && refundRows.every((row) => row.refundAmount !== null)
      ? sumMoney(refundRows.map((row) => row.refundAmount!.toNumber()))
      : null,
    freshness: sync.freshness,
    dataAsOf: sync.dataAsOf ?? oldestIso([fetchedAt, refundFetchedAt]),
    lastAttemptAt: sync.lastAttemptAt,
    source: sync.source,
    partial: sync.partial || !completeRows || !completeRefundRows,
    freshnessByType: sync.freshnessByType,
  };
}

function buildTrend(shops: PeriodShop[], range: ReturnType<typeof resolveDashboardRange>) {
  return Array.from({ length: range.dayCount }, (_, index) => {
    const current = addBusinessDays(range.start, index);
    const previous = addBusinessDays(range.previousStart, index);
    return {
      date: current.slice(5),
      sales: salesForDate(shops, current),
      previous: salesForDate(shops, previous),
    };
  });
}

function salesForDate(shops: PeriodShop[], date: string) {
  if (!shops.length) return null;
  const values = shops.map((shop) => shop.salesDaily.find((row) => toBusinessDateKey(row.tradeDate) === date)?.salesAmount?.toNumber() ?? null);
  return values.every((value): value is number => value !== null) ? sumMoney(values) : null;
}

function daysBetween(start: string, end: string) {
  return Math.round((businessDateAsUtc(end).getTime() - businessDateAsUtc(start).getTime()) / 86_400_000);
}

function sumMoney(values: number[]) {
  return values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
}

function dashboardSummary(metrics: SalesMetric[]) {
  const summary = summarizeSales(metrics);
  const refundPartial = metrics.some((metric) => metric.refundAmount === null);
  return { ...summary, refundAmount: refundPartial ? null : summary.refundAmount, refundPartial };
}

function summaryChanges(current: ReturnType<typeof dashboardSummary>, previous: ReturnType<typeof dashboardSummary>) {
  return {
    salesAmount: calculateChange(current.salesAmount, previous.salesAmount),
    transactionCount: calculateChange(current.transactionCount, previous.transactionCount),
    payBuyerCount: calculateChange(current.payBuyerCount, previous.payBuyerCount),
    averageOrderValue: current.averageOrderValue === null || previous.averageOrderValue === null ? null : calculateChange(current.averageOrderValue, previous.averageOrderValue),
    refundAmount: current.refundAmount === null || previous.refundAmount === null ? null : calculateChange(current.refundAmount, previous.refundAmount),
  };
}
