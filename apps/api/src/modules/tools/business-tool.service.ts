import { Inject, Injectable, Optional } from "@nestjs/common";
import { z } from "zod";
import { calculateFreshness } from "@fuduo/shared";
import { Prisma } from "@fuduo/database";
import { DatabaseService } from "../database/database.service.js";
import { BusinessDataService } from "../data/business-data.service.js";
import { AccessControlService } from "../auth/access-control.service.js";
import { canReceiveReport } from "../reports/report-access.js";
import { resolveDataFreshness } from "../data/data-freshness.js";

export { canReceiveReport } from "../reports/report-access.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isDate, "日期无效");
const shopId = z.string().regex(/^\d+$/);
const dateRange = { startDate: date.optional(), endDate: date.optional() };

const schemas = {
  list_shops: z.object({ search: z.string().max(100).optional() }).strict(),
  get_shop_sales: z.object({ shopId, ...dateRange }).strict(),
  compare_shop_sales: z.object({ shopIds: z.array(shopId).min(2).max(10), ...dateRange }).strict(),
  rank_shops_by_sales: z.object({ limit: z.number().int().min(1).max(10).optional(), ...dateRange }).strict(),
  get_sales_summary: z.object({ shopIds: z.array(shopId).max(10).optional(), ...dateRange }).strict(),
  get_shop_orders: z.object({ shopId, ...dateRange }).strict(),
  get_shop_refunds: z.object({ shopId, ...dateRange }).strict(),
  generate_daily_report: z.object({ date: date.optional(), shopIds: z.array(shopId).max(50).optional(), scheduledReportId: z.string().uuid().optional() }).strict(),
  generate_weekly_report: z.object({ weekStart: date.optional(), shopIds: z.array(shopId).max(50).optional(), scheduledReportId: z.string().uuid().optional() }).strict(),
  get_data_freshness: z.object({ shopIds: z.array(shopId).max(10).optional() }).strict(),
  get_sync_status: z.object({ limit: z.number().int().min(1).max(50).optional() }).strict(),
} as const;

export type BusinessToolName = keyof typeof schemas;

export function parseBusinessToolInput(name: BusinessToolName, input: unknown) {
  return schemas[name].parse(input) as Record<string, unknown>;
}

@Injectable()
export class BusinessToolService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(BusinessDataService) private readonly data: BusinessDataService,
    @Optional() @Inject(AccessControlService) private readonly access?: AccessControlService,
  ) {}

  hasTool(name: string): name is BusinessToolName {
    return Object.hasOwn(schemas, name);
  }

  async invoke(name: BusinessToolName, rawParams: unknown, context: ToolContext = {}) {
    return (await this.invokeTracked(name, rawParams, context)).result;
  }

  async invokeTracked(name: BusinessToolName, rawParams: unknown, context: ToolContext = {}) {
    const started = Date.now();
    const params = parseBusinessToolInput(name, rawParams);
    try {
      if (this.access && !context.system && (name === "generate_daily_report" || name === "generate_weekly_report")) {
        await this.access.assertPermission(context.userId, "reports:generate");
      }
      const requested = requestedShopIds(name, params as Record<string, unknown>);
      const allowedShopIds = context.system ? (requested.length ? requested : null) : this.access ? await this.access.readableShopIds(context.userId, requested) : null;
      const result = await this.execute(name, params as Record<string, unknown>, allowedShopIds, context.userId);
      const toolRunId = await this.audit(name, params, result, Date.now() - started, "SUCCEEDED", undefined, context.userId);
      return { result, toolRunId };
    } catch (error) {
      await this.audit(name, params, null, Date.now() - started, "FAILED", errorCode(error), context.userId);
      throw error;
    }
  }

  private async execute(name: BusinessToolName, params: Record<string, unknown>, allowedShopIds: string[] | null, userId?: string) {
    switch (name) {
      case "list_shops": {
        const shops = await this.data.listShops(allowedShopIds);
        const search = typeof params.search === "string" ? params.search.trim().toLocaleLowerCase("zh-CN") : "";
        const filtered = search ? shops.filter((shop) => shop.name.toLocaleLowerCase("zh-CN").includes(search)) : shops;
        return {
          shops: filtered.map((shop) => ({ ...shop, freshness: shop.freshness ?? calculateFreshness(shop.lastSyncedAt ? new Date(shop.lastSyncedAt) : null) })),
          count: filtered.length,
        };
      }
      case "get_shop_sales":
        return this.sales([String(params.shopId)], rangeFrom(params), allowedShopIds);
      case "compare_shop_sales":
        return this.sales(params.shopIds as string[], rangeFrom(params), allowedShopIds);
      case "rank_shops_by_sales": {
        const result = await this.sales(undefined, rangeFrom(params), allowedShopIds);
        return { ...result, shops: result.shops.slice(0, Number(params.limit ?? 10)) };
      }
      case "get_sales_summary":
        return this.sales(params.shopIds as string[] | undefined, rangeFrom(params), allowedShopIds);
      case "get_shop_orders":
        return this.dailyRecords("orders", String(params.shopId), rangeFrom(params), allowedShopIds);
      case "get_shop_refunds":
        return this.dailyRecords("refunds", String(params.shopId), rangeFrom(params), allowedShopIds);
      case "generate_daily_report": {
        const reportDate = String(params.date ?? defaultDailyReportDate());
        return this.generateReport("DAILY", reportDate, reportDate, allowedShopIds, userId, typeof params.scheduledReportId === "string" ? params.scheduledReportId : undefined);
      }
      case "generate_weekly_report": {
        const start = String(params.weekStart ?? defaultWeeklyReportStart());
        return this.generateReport("WEEKLY", start, addDays(start, 6), allowedShopIds, userId, typeof params.scheduledReportId === "string" ? params.scheduledReportId : undefined);
      }
      case "get_data_freshness": {
        const requested = params.shopIds as string[] | undefined;
        const shops = await this.data.listShops(allowedShopIds);
        const selected = requested?.length ? shops.filter((shop) => requested.includes(String(shop.id))) : shops;
        return {
          shops: selected.map((shop) => ({
            shopId: String(shop.id),
            shopName: shop.name,
            freshness: shop.freshness ?? calculateFreshness(shop.lastSyncedAt ? new Date(shop.lastSyncedAt) : null),
            dataAsOf: shop.dataAsOf ?? shop.lastSyncedAt,
            lastAttemptAt: shop.lastAttemptAt ?? null,
            source: shop.source ?? null,
            partial: shop.partial ?? true,
          })),
        };
      }
      case "get_sync_status": {
        const runs = await this.data.syncRuns(allowedShopIds);
        return { runs: runs.slice(0, Number(params.limit ?? 20)) };
      }
    }
  }

  private async sales(requestedShopIds: string[] | undefined, range: DateRange, allowedShopIds: string[] | null) {
    if (!this.database.enabled) {
      const dashboard = await this.data.dashboard("today", [], undefined, allowedShopIds);
      const selected = requestedShopIds?.length
        ? dashboard.rankings.filter((shop) => requestedShopIds.includes(String(shop.shopId)))
        : dashboard.rankings;
      return {
        period: range,
        shops: selected,
        summary: summarize(selected),
        freshness: dashboard.freshness,
        dataAsOf: dashboard.dataAsOf,
        partial: selected.some((shop) => shop.salesAmount === null),
      };
    }

    const effective = requestedShopIds?.length ? requestedShopIds : allowedShopIds;
    const requested = effective?.map(BigInt);
    const rows = await this.database.prisma.shop.findMany({
      where: { status: "ACTIVE", ...(effective !== null && effective !== undefined ? { fuduoShopId: { in: requested ?? [] } } : {}) },
      include: {
        salesDaily: {
          where: { tradeDate: { gte: dbDate(range.startDate), lte: dbDate(range.endDate) } },
          orderBy: { tradeDate: "asc" },
        },
        refundDaily: {
          where: { tradeDate: { gte: dbDate(range.startDate), lte: dbDate(range.endDate) } },
          orderBy: { tradeDate: "asc" },
        },
        dataSyncStates: {
          where: { tradeDate: { gte: dbDate(range.startDate), lte: dbDate(range.endDate) }, dataType: { in: ["sales", "refunds"] } },
        },
      },
      orderBy: { name: "asc" },
    });
    const shops = rows.map((shop) => {
      const sync = resolveDataFreshness(shop.dataSyncStates ?? [], ["SALES", "REFUNDS"], range.startDate, range.endDate);
      const expectedDays = daysInRange(range);
      const salesMissing = shop.salesDaily.length !== expectedDays
        || shop.salesDaily.some((item) => item.salesAmount === null || item.transactionCount === null);
      const refundMissing = shop.refundDaily.length !== expectedDays
        || shop.refundDaily.some((item) => item.refundAmount === null);
      const missing = salesMissing || refundMissing;
      const salesAmount = salesMissing ? null : sumMoney(shop.salesDaily.map((item) => item.salesAmount?.toNumber() ?? null));
      const transactionCount = salesMissing ? null : sum(shop.salesDaily.map((item) => item.transactionCount));
      const payBuyerCount = salesMissing ? null : sum(shop.salesDaily.map((item) => item.payBuyerCount));
      const refundAmount = refundMissing ? null : sumMoney(shop.refundDaily.map((item) => item.refundAmount?.toNumber() ?? null));
      return {
        shopId: String(shop.fuduoShopId),
        shopName: shop.name,
        salesAmount,
        transactionCount,
        payBuyerCount,
        refundAmount,
        averageOrderValue: transactionCount && salesAmount !== null ? roundMoney(salesAmount / transactionCount) : null,
        freshness: sync.freshness,
        dataAsOf: sync.dataAsOf,
        lastAttemptAt: sync.lastAttemptAt,
        source: sync.source,
        partial: sync.partial || missing,
        freshnessByType: sync.freshnessByType,
        missing,
      };
    }).sort((a, b) => (b.salesAmount ?? -Infinity) - (a.salesAmount ?? -Infinity));
    const dataAsOf = oldest(shops.map((shop) => shop.dataAsOf ? new Date(shop.dataAsOf) : null));
    const lastAttemptAt = newest(shops.map((shop) => shop.lastAttemptAt ? new Date(shop.lastAttemptAt) : null));
    return {
      period: range,
      shops,
      summary: summarize(shops),
      freshness: worstFreshness(shops.map((shop) => shop.freshness)),
      dataAsOf: dataAsOf?.toISOString() ?? null,
      lastAttemptAt: lastAttemptAt?.toISOString() ?? null,
      source: combineSources(shops.map((shop) => shop.source)),
      partial: shops.some((shop) => shop.partial),
      missingShops: shops.filter((shop) => shop.missing).map((shop) => shop.shopName),
    };
  }

  private async dailyRecords(type: "orders" | "refunds", externalShopId: string, range: DateRange, allowedShopIds: string[] | null) {
    if (!this.database.enabled) {
      return { shopId: externalShopId, period: range, rows: [], dataAsOf: null, freshness: "UNKNOWN", unavailable: true };
    }
    if (allowedShopIds !== null && !allowedShopIds.includes(externalShopId)) throw new Error("SHOP_NOT_FOUND");
    const shop = await this.database.prisma.shop.findUnique({ where: { fuduoShopId: BigInt(externalShopId) } });
    if (!shop) throw new Error("SHOP_NOT_FOUND");
    if (type === "orders") {
      const [rows, states] = await Promise.all([
        this.database.prisma.orderDaily.findMany({
          where: { shopId: shop.id, tradeDate: { gte: dbDate(range.startDate), lte: dbDate(range.endDate) } },
          orderBy: { tradeDate: "asc" },
        }),
        this.database.prisma.dataSyncState.findMany({
          where: { shopId: shop.id, dataType: "orders", tradeDate: { gte: dbDate(range.startDate), lte: dbDate(range.endDate) } },
        }),
      ]);
      const sync = resolveDataFreshness(states, ["ORDERS"], range.startDate, range.endDate);
      return {
        shopId: externalShopId,
        shopName: shop.name,
        period: range,
        rows: rows.map((row) => ({ date: dayKey(row.tradeDate), orderCount: row.orderCount, paidOrderCount: row.paidOrderCount, paidAmount: row.paidAmount?.toNumber() ?? null })),
        ...sync,
        partial: sync.partial || rows.length !== daysInRange(range) || rows.some((row) => row.orderCount === null || row.paidAmount === null),
      };
    }
    const [rows, states] = await Promise.all([
      this.database.prisma.refundDaily.findMany({
        where: { shopId: shop.id, tradeDate: { gte: dbDate(range.startDate), lte: dbDate(range.endDate) } },
        orderBy: { tradeDate: "asc" },
      }),
      this.database.prisma.dataSyncState.findMany({
        where: { shopId: shop.id, dataType: "refunds", tradeDate: { gte: dbDate(range.startDate), lte: dbDate(range.endDate) } },
      }),
    ]);
    const sync = resolveDataFreshness(states, ["REFUNDS"], range.startDate, range.endDate);
    return {
      shopId: externalShopId,
      shopName: shop.name,
      period: range,
      rows: rows.map((row) => ({ date: dayKey(row.tradeDate), refundCount: row.refundCount, refundAmount: row.refundAmount?.toNumber() ?? null })),
      ...sync,
      partial: sync.partial || rows.length !== daysInRange(range) || rows.some((row) => row.refundAmount === null),
    };
  }

  private async generateReport(type: "DAILY" | "WEEKLY", startDate: string, endDate: string, allowedShopIds: string[] | null, userId?: string, scheduledReportId?: string) {
    const data = await this.sales(undefined, { startDate, endDate }, allowedShopIds);
    if (!this.database.enabled) return { id: `demo-${type.toLowerCase()}`, type, version: 1, ...data };
    const shopIds = [...new Set(data.shops.map((shop) => String(shop.shopId)))].sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
    const deliveryTargets = await this.reportDeliveryTargets(scheduledReportId, shopIds);
    const latest = await this.database.prisma.reportSnapshot.findFirst({
      where: { type, periodStart: dbDate(startDate), periodEnd: dbDate(endDate), ...(scheduledReportId ? { scheduledReportId } : { scheduledReportId: null, shopIds: { equals: shopIds } }) },
      orderBy: { version: "desc" },
    });
    const snapshot = await this.database.prisma.reportSnapshot.create({
      data: {
        type,
        periodStart: dbDate(startDate),
        periodEnd: dbDate(endDate),
        version: (latest?.version ?? 0) + 1,
        shopIds,
        ...(scheduledReportId ? { scheduledReportId } : {}),
        ...(userId ? { createdByUserId: userId } : {}),
        data: toJson(data),
        dataAsOf: data.dataAsOf ? new Date(data.dataAsOf) : new Date(0),
        deliveries: { create: deliveryTargets },
      },
      include: { deliveries: true },
    });
    return { id: snapshot.id, type, version: snapshot.version, deliveries: snapshot.deliveries.map((delivery) => ({ id: delivery.id, channel: delivery.channel, status: delivery.status })), ...data };
  }

  private async reportDeliveryTargets(scheduledReportId: string | undefined, shopIds: string[]) {
    const now = new Date();
    const schedule = scheduledReportId
      ? await this.database.prisma.scheduledReport.findUnique({ where: { id: scheduledReportId }, select: { channels: true } })
      : null;
    if (scheduledReportId && !schedule) throw new Error("REPORT_SCHEDULE_NOT_FOUND");
    const channels = schedule?.channels ?? ["WEB"];
    const targets: Array<{ channel: string; recipient: string; status: string; attempts?: number; lastAttemptAt?: Date; sentAt?: Date }> = [];
    if (channels.includes("WEB")) targets.push({ channel: "WEB", recipient: "web", status: "SUCCEEDED", attempts: 1, lastAttemptAt: now, sentAt: now });
    if (!channels.includes("WECHAT") || !this.access) return targets;
    const pairings = await this.database.prisma.channelUser.findMany({
      where: { revokedAt: null, user: { active: true }, channelAccount: { channel: "openclaw-weixin", active: true } },
      select: { externalUserId: true, userId: true },
    });
    for (const pairing of pairings) {
      const scope = await this.access.scope(pairing.userId).catch(() => null);
      if (scope && canReceiveReport(scope, shopIds)) targets.push({ channel: "WECHAT", recipient: pairing.externalUserId, status: "QUEUED" });
    }
    return targets;
  }

  private async audit(name: BusinessToolName, params: unknown, result: unknown, durationMs: number, status: string, code?: string, userId?: string) {
    if (!this.database.enabled) return null;
    const meta = result && typeof result === "object"
      ? { dataAsOf: (result as { dataAsOf?: unknown }).dataAsOf ?? null, freshness: (result as { freshness?: unknown }).freshness ?? null }
      : null;
    const created = await this.database.prisma.toolRun.create({
      data: {
        ...(userId ? { userId } : {}),
        name,
        status,
        params: toJson(params),
        resultMeta: meta ? toJson(meta) : Prisma.JsonNull,
        durationMs,
        errorCode: code ?? null,
      },
    }).catch(() => null);
    return created?.id ?? null;
  }
}

interface DateRange { startDate: string; endDate: string }
interface ToolContext { userId?: string; system?: boolean }

function rangeFrom(params: Record<string, unknown>): DateRange {
  const endDate = typeof params.endDate === "string" ? params.endDate : shanghaiDate();
  const startDate = typeof params.startDate === "string" ? params.startDate : endDate;
  if (startDate > endDate) throw new Error("DATA_INVALID_DATE_RANGE");
  return { startDate, endDate };
}

function summarize(rows: Array<{ salesAmount: number | null; transactionCount: number | null; payBuyerCount: number | null; refundAmount: number | null }>) {
  const salesAmount = sumMoney(rows.map((row) => row.salesAmount));
  const transactionCount = sum(rows.map((row) => row.transactionCount));
  const payBuyerCount = sum(rows.map((row) => row.payBuyerCount));
  const refundAmount = sumMoney(rows.map((row) => row.refundAmount));
  return {
    salesAmount,
    transactionCount,
    payBuyerCount,
    refundAmount,
    averageOrderValue: transactionCount && salesAmount !== null ? roundMoney(salesAmount / transactionCount) : null,
  };
}

function sum(values: Array<number | null>): number | null {
  if (!values.length || values.some((value) => value === null)) return null;
  return (values as number[]).reduce((total, value) => total + value, 0);
}

function sumMoney(values: Array<number | null>): number | null {
  if (!values.length || values.some((value) => value === null)) return null;
  return (values as number[]).reduce((cents, value) => cents + Math.round(value * 100), 0) / 100;
}

function roundMoney(value: number) { return Math.round(value * 100) / 100; }

function oldest(values: Array<Date | null>): Date | null {
  const available = values.filter((value): value is Date => value !== null);
  return available.length ? new Date(Math.min(...available.map((value) => value.getTime()))) : null;
}

function newest(values: Array<Date | null>): Date | null {
  const available = values.filter((value): value is Date => value !== null);
  return available.length ? new Date(Math.max(...available.map((value) => value.getTime()))) : null;
}

function daysInRange(range: DateRange) {
  return Math.round((dbDate(range.endDate).getTime() - dbDate(range.startDate).getTime()) / 86_400_000) + 1;
}

function worstFreshness(values: Array<"LIVE" | "RECENT" | "STALE" | "UNKNOWN">) {
  const order = ["LIVE", "RECENT", "STALE", "UNKNOWN"] as const;
  return values.reduce((worst, value) => order.indexOf(value) > order.indexOf(worst) ? value : worst, "LIVE" as typeof order[number]);
}

function combineSources(values: Array<string | null>) {
  const sources = [...new Set(values.filter((value): value is string => Boolean(value)))];
  return sources.length === 0 ? null : sources.length === 1 ? sources[0]! : "MULTIPLE";
}

function dbDate(value: string) { return new Date(`${value}T00:00:00.000Z`); }
function dayKey(value: Date) { return value.toISOString().slice(0, 10); }
function addDays(value: string, days: number) { const result = dbDate(value); result.setUTCDate(result.getUTCDate() + days); return dayKey(result); }
function isDate(value: string) { return !Number.isNaN(dbDate(value).getTime()) && dayKey(dbDate(value)) === value; }
export function defaultDailyReportDate(now = new Date()) { return addDays(shanghaiDate(now), -1); }
export function defaultWeeklyReportStart(now = new Date()) {
  const current = dbDate(shanghaiDate(now));
  const day = current.getUTCDay() || 7;
  current.setUTCDate(current.getUTCDate() - day - 6);
  return dayKey(current);
}
function shanghaiDate(now = new Date()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
function errorCode(error: unknown) { return error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "TOOL_FAILED"; }
function toJson(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }

function requestedShopIds(name: BusinessToolName, params: Record<string, unknown>): string[] {
  if (name === "get_shop_sales" || name === "get_shop_orders" || name === "get_shop_refunds") return [String(params.shopId)];
  if (name === "compare_shop_sales" || name === "get_sales_summary" || name === "get_data_freshness" || name === "generate_daily_report" || name === "generate_weekly_report") return (params.shopIds as string[] | undefined) ?? [];
  return [];
}
