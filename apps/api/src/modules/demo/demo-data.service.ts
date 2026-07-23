import { Injectable } from "@nestjs/common";
import { calculateChange, rankBySales, summarizeSales } from "@fuduo/analytics";
import type { SalesMetric, Shop } from "@fuduo/shared";
import type { DashboardRange } from "../data/dashboard-period.js";
import { addBusinessDays } from "../data/dashboard-period.js";

const DATA_AS_OF = "2026-07-21T08:35:00.000Z";
const DEMO_SYNC_START_DELAY_MS = 300;
const DEMO_SYNC_COMPLETE_DELAY_MS = 1_500;

@Injectable()
export class DemoDataService {
  private readonly submittedSyncRuns: DemoSyncRun[] = [];

  readonly shops: Shop[] = [
    { id: 10218, accountId: 2255, name: "云野生活馆", platform: "pdd", loginStatus: "正常", todaySales: 18642.3, todayOrders: 328, refundAmount: 642.8, lastSyncedAt: DATA_AS_OF },
    { id: 10232, accountId: 2261, name: "拾光家居", platform: "pdd", loginStatus: "正常", todaySales: 15480.2, todayOrders: 271, refundAmount: 388.5, lastSyncedAt: DATA_AS_OF },
    { id: 10257, accountId: 2270, name: "简物优选", platform: "pdd", loginStatus: "正常", todaySales: 12690.45, todayOrders: 206, refundAmount: 521.2, lastSyncedAt: DATA_AS_OF },
    { id: 10271, accountId: 2284, name: "晴川百货", platform: "pdd", loginStatus: "待重新登录", todaySales: 8642.0, todayOrders: 142, refundAmount: 292.0, lastSyncedAt: "2026-07-21T07:01:00.000Z" },
    { id: 10305, accountId: 2291, name: "良品日用", platform: "pdd", loginStatus: "正常", todaySales: 7328.6, todayOrders: 119, refundAmount: 165.8, lastSyncedAt: DATA_AS_OF },
  ];

  readonly sales: SalesMetric[] = this.shops.map((shop) => ({
    shopId: shop.id,
    shopName: shop.name,
    tradeDate: "2026-07-21",
    salesAmount: shop.todaySales,
    transactionCount: shop.todayOrders,
    payBuyerCount: shop.todayOrders === null ? null : Math.round(shop.todayOrders * 0.93),
    averageOrderValue: shop.todaySales !== null && shop.todayOrders ? shop.todaySales / shop.todayOrders : null,
    refundAmount: shop.refundAmount,
    freshness: shop.name === "晴川百货" ? "STALE" : "LIVE",
    dataAsOf: shop.lastSyncedAt ?? DATA_AS_OF,
  }));

  readonly trend = [
    { date: "07-15", sales: 48210, previous: 45180 },
    { date: "07-16", sales: 52140, previous: 47620 },
    { date: "07-17", sales: 49780, previous: 48830 },
    { date: "07-18", sales: 58620, previous: 51420 },
    { date: "07-19", sales: 54880, previous: 53690 },
    { date: "07-20", sales: 60120, previous: 55940 },
    { date: "07-21", sales: 62783.55, previous: 57240 },
  ];

  dashboard(range: DashboardRange, shopIds: string[] = []) {
    const selected = shopIds.length ? this.sales.filter((metric) => shopIds.includes(String(metric.shopId))) : this.sales;
    const allShopsTotal = summarizeSales(this.sales).salesAmount;
    const baseTotal = summarizeSales(selected).salesAmount;
    const selectionShare = allShopsTotal > 0 ? baseTotal / allShopsTotal : 0;
    const trend = Array.from({ length: range.dayCount }, (_, index) => {
      const date = addBusinessDays(range.start, index);
      const previousDate = addBusinessDays(range.previousStart, index);
      return { date: date.slice(5), sales: roundMoney(demoDailyTotal(date) * selectionShare), previous: roundMoney(demoDailyTotal(previousDate) * selectionShare) };
    });
    const currentTotal = sumMoney(trend.map((item) => item.sales));
    const previousTotal = sumMoney(trend.map((item) => item.previous));
    const metrics = selected.map((metric) => scaleMetric(metric, baseTotal > 0 ? currentTotal / baseTotal : 0, range));
    const previousMetrics = selected.map((metric) => scaleMetric(metric, baseTotal > 0 ? previousTotal / baseTotal : 0, range));
    const summary = summarizeSales(metrics);
    const previousSummary = summarizeSales(previousMetrics);
    return {
      period: range.period,
      range,
      summary,
      changes: {
        salesAmount: calculateChange(summary.salesAmount, previousSummary.salesAmount),
        transactionCount: calculateChange(summary.transactionCount, previousSummary.transactionCount),
        payBuyerCount: calculateChange(summary.payBuyerCount, previousSummary.payBuyerCount),
        averageOrderValue: summary.averageOrderValue === null || previousSummary.averageOrderValue === null ? null : calculateChange(summary.averageOrderValue, previousSummary.averageOrderValue),
        refundAmount: calculateChange(summary.refundAmount, previousSummary.refundAmount),
      },
      rankings: rankBySales(metrics),
      trend,
      freshness: "STALE" as const,
      dataAsOf: DATA_AS_OF,
      alerts: [
        { id: "alert-1", level: "warning", title: "晴川百货数据已过期", detail: "最后成功同步于 1 小时 34 分钟前" },
        { id: "alert-2", level: "info", title: "退款金额较昨日下降 8.4%", detail: "当前累计退款 ¥2,010.30" },
      ],
    };
  }

  syncRuns() {
    return [
      ...this.submittedSyncRuns,
      { id: "sync-1042", type: "sales-live-sync", status: "SUCCEEDED", total: 5, success: 5, failed: 0, payload: { tradeDate: "2026-07-21" }, createdAt: "2026-07-21T08:34:11.000Z", startedAt: "2026-07-21T08:34:12.000Z", finishedAt: "2026-07-21T08:34:13.823Z", durationMs: 1823, requestedBy: "scheduler", errorCode: null, errorMessage: null },
      { id: "sync-1041", type: "shop-catalog-sync", status: "SUCCEEDED", total: 5, success: 5, failed: 0, payload: {}, createdAt: "2026-07-21T08:29:59.000Z", startedAt: "2026-07-21T08:30:00.000Z", finishedAt: "2026-07-21T08:30:00.724Z", durationMs: 724, requestedBy: "scheduler", errorCode: null, errorMessage: null },
      {
        id: "sync-1040", type: "sales-live-sync", status: "PARTIAL", total: 5, success: 4, failed: 1,
        payload: { tradeDate: "2026-07-21", shopIds: ["101", "102", "103", "104", "105"] },
        createdAt: "2026-07-21T08:24:59.000Z", startedAt: "2026-07-21T08:25:00.000Z", finishedAt: "2026-07-21T08:25:03.218Z", durationMs: 3218,
        requestedBy: "web", errorCode: "ERP_SHOP_UNAVAILABLE", errorMessage: "一个或多个店铺同步失败",
        items: [
          { id: "sync-item-1040-101", dataType: "sales", tradeDate: "2026-07-21", fuduoShopId: "101", shopName: "星桥家居旗舰店", status: "SUCCEEDED", attempt: 1, errorCode: null, errorMessage: null, startedAt: "2026-07-21T08:25:00.100Z", finishedAt: "2026-07-21T08:25:01.210Z" },
          { id: "sync-item-1040-102", dataType: "sales", tradeDate: "2026-07-21", fuduoShopId: "102", shopName: "青禾生活馆", status: "SUCCEEDED", attempt: 1, errorCode: null, errorMessage: null, startedAt: "2026-07-21T08:25:00.100Z", finishedAt: "2026-07-21T08:25:01.508Z" },
          { id: "sync-item-1040-103", dataType: "sales", tradeDate: "2026-07-21", fuduoShopId: "103", shopName: "简物优选", status: "SUCCEEDED", attempt: 1, errorCode: null, errorMessage: null, startedAt: "2026-07-21T08:25:00.100Z", finishedAt: "2026-07-21T08:25:02.104Z" },
          { id: "sync-item-1040-104", dataType: "sales", tradeDate: "2026-07-21", fuduoShopId: "104", shopName: "拾光百货", status: "SUCCEEDED", attempt: 1, errorCode: null, errorMessage: null, startedAt: "2026-07-21T08:25:01.220Z", finishedAt: "2026-07-21T08:25:02.630Z" },
          { id: "sync-item-1040-105", dataType: "sales", tradeDate: "2026-07-21", fuduoShopId: "105", shopName: "木棉小铺", status: "FAILED", attempt: 2, errorCode: "ERP_SHOP_UNAVAILABLE", errorMessage: "店铺数据同步失败", startedAt: "2026-07-21T08:25:02.120Z", finishedAt: "2026-07-21T08:25:03.218Z" },
        ],
      },
    ];
  }

  enqueueSyncRun(type: string, tradeDate?: string, shopIds?: string[], requestedBy = "web", sourceRunId?: string) {
    const now = new Date().toISOString();
    const resolvedShopIds = shopIds ?? (isShopScopedSync(type) ? this.shops.map((shop) => String(shop.id)) : undefined);
    const resolvedTradeDate = isDailySync(type) ? tradeDate ?? shanghaiBusinessDate() : tradeDate;
    const payload = {
      ...(resolvedTradeDate ? { tradeDate: resolvedTradeDate } : {}),
      ...(type === "sales-reconcile" ? { tradeDates: recentBusinessDates(7) } : {}),
      ...(resolvedShopIds ? { shopIds: resolvedShopIds } : {}),
      ...(sourceRunId ? { sourceRunId } : {}),
    };
    const run: DemoSyncRun = {
      id: crypto.randomUUID(),
      type,
      status: "QUEUED",
      total: resolvedShopIds?.length ?? this.shops.length,
      success: 0,
      failed: 0,
      payload,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      durationMs: null,
      requestedBy,
      errorCode: null,
      errorMessage: null,
    };
    this.submittedSyncRuns.unshift(run);
    this.simulateSyncRun(run);
    return { ...run, demo: true };
  }

  private simulateSyncRun(run: DemoSyncRun) {
    const startTimer = setTimeout(() => {
      if (run.status !== "QUEUED") return;
      const startedAt = new Date().toISOString();
      run.status = "RUNNING";
      run.startedAt = startedAt;
      run.items = demoSyncItems(run, this.shops, startedAt);
      if (run.items.length) run.total = run.items.length;
    }, DEMO_SYNC_START_DELAY_MS);
    startTimer.unref();

    const completeTimer = setTimeout(() => {
      if (run.status !== "RUNNING") return;
      const finishedAt = new Date().toISOString();
      run.status = "SUCCEEDED";
      run.success = run.total;
      run.failed = 0;
      run.finishedAt = finishedAt;
      run.durationMs = new Date(finishedAt).getTime() - new Date(run.startedAt).getTime();
      for (const item of run.items ?? []) {
        item.status = "SUCCEEDED";
        item.finishedAt = finishedAt;
      }
    }, DEMO_SYNC_COMPLETE_DELAY_MS);
    completeTimer.unref();
  }

  retrySyncRun(runId: string, shopIds: string[] | undefined, requestedBy: string) {
    const original = this.syncRuns().find((run) => run.id === runId);
    if (!original) return null;
    return this.enqueueSyncRun(
      original.type,
      original.payload.tradeDate,
      shopIds ?? original.payload.shopIds,
      requestedBy,
      original.id,
    );
  }

  syncQueueStatus() {
    return {
      connected: true,
      demoMode: true,
      queueLength: this.submittedSyncRuns.filter((run) => run.status === "QUEUED").length,
      active: this.submittedSyncRuns.filter((run) => run.status === "RUNNING").length,
      failed: this.submittedSyncRuns.filter((run) => run.status === "FAILED").length,
    };
  }
}

interface DemoSyncRun {
  id: string;
  type: string;
  status: string;
  total: number;
  success: number;
  failed: number;
  payload: { tradeDate?: string; tradeDates?: string[]; shopIds?: string[]; sourceRunId?: string };
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  requestedBy: string;
  errorCode: string | null;
  errorMessage: string | null;
  items?: Array<{
    id: string;
    dataType: string;
    tradeDate: string;
    fuduoShopId: string;
    shopName: string;
    status: string;
    attempt: number;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: string;
    finishedAt: string | null;
  }>;
}

function isShopScopedSync(type: string) {
  return ["sales-live-sync", "sales-reconcile", "orders-sync", "refunds-sync"].includes(type);
}

function isDailySync(type: string) {
  return ["sales-live-sync", "orders-sync", "refunds-sync"].includes(type);
}

function demoSyncItems(run: DemoSyncRun, shops: Shop[], startedAt: string): NonNullable<DemoSyncRun["items"]> {
  const dataType = demoDataType(run.type);
  const shopIds = run.payload.shopIds;
  if (!dataType || !shopIds?.length) return [];
  const tradeDates = run.payload.tradeDates ?? [run.payload.tradeDate ?? shanghaiBusinessDate()];
  const shopNames = new Map(shops.map((shop) => [String(shop.id), shop.name]));
  return tradeDates.flatMap((tradeDate) => shopIds.map((shopId) => ({
    id: `demo-item-${run.id}-${dataType}-${tradeDate}-${shopId}`,
    dataType,
    tradeDate,
    fuduoShopId: shopId,
    shopName: shopNames.get(shopId) ?? `店铺 ${shopId}`,
    status: "RUNNING",
    attempt: 1,
    errorCode: null,
    errorMessage: null,
    startedAt,
    finishedAt: null,
  })));
}

function demoDataType(type: string) {
  if (["sales-live-sync", "sales-reconcile"].includes(type)) return "sales";
  if (type === "orders-sync") return "orders";
  if (type === "refunds-sync") return "refunds";
  return null;
}

function shanghaiBusinessDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function recentBusinessDates(days: number) {
  const current = new Date(`${shanghaiBusinessDate()}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(current);
    date.setUTCDate(current.getUTCDate() - index);
    return date.toISOString().slice(0, 10);
  });
}

function scaleMetric(metric: SalesMetric, factor: number, range: DashboardRange): SalesMetric {
  const transactionCount = metric.transactionCount === null ? null : Math.round(metric.transactionCount * factor);
  const salesAmount = metric.salesAmount === null ? null : roundMoney(metric.salesAmount * factor);
  return {
    ...metric,
    tradeDate: range.start === range.end ? range.end : `${range.start}/${range.end}`,
    salesAmount,
    transactionCount,
    payBuyerCount: metric.payBuyerCount === null ? null : Math.round(metric.payBuyerCount * factor),
    refundAmount: metric.refundAmount === null ? null : roundMoney(metric.refundAmount * factor),
    averageOrderValue: salesAmount !== null && transactionCount ? roundMoney(salesAmount / transactionCount) : null,
  };
}

function demoDailyTotal(date: string) {
  const day = Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 86_400_000);
  const weekday = ((day % 7) + 7) % 7;
  return roundMoney(53_000 + weekday * 1_550 + ((day * 7_919) % 4_000 + 4_000) % 4_000);
}

function sumMoney(values: number[]) {
  return values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}
