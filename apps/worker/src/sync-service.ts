import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@fuduo/database";
import { FuduoApiError, FuduoClient, type SalesLive } from "@fuduo/fuduo-sdk";
import { CredentialProvider } from "./credential-provider.js";
import { collectOrderDaily, collectRefundDaily, shanghaiDayWindow } from "./commerce-daily.js";
import { noSyncLease, type SyncLease } from "./sync-lease.js";
import { isTerminalSyncError } from "./sync-retry.js";

export class SyncService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly credentials: CredentialProvider,
    private readonly createClient: (token: string) => FuduoClient = (token) => new FuduoClient({ getAccessToken: () => token }),
    private readonly lease: SyncLease = noSyncLease,
  ) {}

  async syncShops(syncRunId: string) {
    const foundIds = new Set<bigint>();
    const pageFingerprints = new Set<string>();
    let page = 1;
    const size = 100;
    const maxPages = 500;
    let received = 0;
    let completed = false;

    while (page <= maxPages) {
      const token = await this.credentials.getToken();
      const result = await this.withRefresh((accessToken) =>
        this.createClient(accessToken).listVisibleShops(page, size), token);
      if (result.current !== undefined && result.current !== page) throw paginationError("富多店铺目录返回了错误页码");
      if (result.size !== undefined && (!Number.isInteger(result.size) || result.size < 1)) throw paginationError("富多店铺目录返回了无效分页大小");
      const fingerprint = result.records.map((shop) => shop.id).join(",");
      if (fingerprint && pageFingerprints.has(fingerprint)) throw paginationError("富多店铺目录重复返回相同页面");
      if (fingerprint) pageFingerprints.add(fingerprint);
      for (const external of result.records) {
        const fuduoShopId = BigInt(external.id);
        foundIds.add(fuduoShopId);
        const shop = await this.prisma.shop.upsert({
          where: { fuduoShopId },
          create: {
            fuduoShopId,
            fuduoAccountId: external.accountId ? BigInt(external.accountId) : null,
            platformCode: external.platformCode ?? "pdd",
            name: external.shopName ?? external.name ?? `店铺 ${external.id}`,
            loginStatus: external.loginStatus === null || external.loginStatus === undefined ? null : String(external.loginStatus),
            status: "ACTIVE",
            lastVisibleAt: new Date(),
          },
          update: {
            fuduoAccountId: external.accountId ? BigInt(external.accountId) : null,
            platformCode: external.platformCode ?? "pdd",
            name: external.shopName ?? external.name ?? `店铺 ${external.id}`,
            loginStatus: external.loginStatus === null || external.loginStatus === undefined ? null : String(external.loginStatus),
            status: "ACTIVE",
            lastVisibleAt: new Date(),
          },
        });
        if (external.accountId) {
          await this.prisma.shopAccount.upsert({
            where: { externalAccountId: BigInt(external.accountId) },
            create: {
              shopId: shop.id,
              externalAccountId: BigInt(external.accountId),
              platformShopId: shop.platformShopId,
              loginStatus: shop.loginStatus,
            },
            update: { shopId: shop.id, loginStatus: shop.loginStatus },
          });
        }
      }
      received += result.records.length;
      const declaredPages = result.pages;
      const declaredTotal = result.total;
      if (declaredPages !== undefined && (!Number.isInteger(declaredPages) || declaredPages < 0)) throw paginationError("富多店铺目录返回了无效总页数");
      if (declaredTotal !== undefined && (!Number.isInteger(declaredTotal) || declaredTotal < 0)) throw paginationError("富多店铺目录返回了无效总数");
      const reachedPages = declaredPages !== undefined && page >= declaredPages;
      const reachedTotal = declaredTotal !== undefined && received >= declaredTotal;
      const noMetadata = declaredPages === undefined && declaredTotal === undefined;
      const shortPage = result.records.length < (result.size ?? size);
      if (reachedPages || reachedTotal || (noMetadata && shortPage)) {
        if (declaredTotal !== undefined && received < declaredTotal) throw paginationError("富多店铺目录在读取完整前提前结束");
        completed = true;
        break;
      }
      if (result.records.length === 0) throw paginationError("富多店铺目录在读取完整前返回空页");
      page += 1;
    }
    if (!completed) throw new FuduoApiError("ERP_PAGINATION_LIMIT", "富多店铺目录分页超过安全限制", 502);

    if (foundIds.size > 0) {
      await this.prisma.shop.updateMany({
        where: { fuduoShopId: { notIn: [...foundIds] }, status: "ACTIVE" },
        data: { status: "INACTIVE" },
      });
    }
    if (foundIds.size === 0) throw new Error("SYNC_NO_ACTIVE_SHOPS");
    await this.completeRun(syncRunId, foundIds.size, foundIds.size, 0, "SUCCEEDED");
    return { total: foundIds.size, success: foundIds.size, failed: 0 };
  }

  async syncSales(syncRunId: string, tradeDate: string, requestedShopIds?: string[], finalizeRun = true) {
    shanghaiDayWindow(tradeDate);
    const shops = await this.prisma.shop.findMany({
      where: {
        status: "ACTIVE",
        ...(requestedShopIds?.length ? { fuduoShopId: { in: requestedShopIds.map((id) => BigInt(id)) } } : {}),
      },
      orderBy: { name: "asc" },
    });
    if (!shops.length) throw new Error("SYNC_NO_ACTIVE_SHOPS");
    const initialToken = shops.length ? await this.credentials.getToken() : null;
    let success = 0;
    const failures: string[] = [];
    await mapConcurrent(shops, 3, async (shop) => {
      const attemptKey = await this.startItem(syncRunId, "sales", tradeDate, shop);
      try {
        await this.lease.run(syncLeaseKey("sales", shop.fuduoShopId, tradeDate), async () => {
          const sales = await this.withRefresh((accessToken) =>
            this.createClient(accessToken).getSalesLive(Number(shop.fuduoShopId), tradeDate), initialToken!);
          assertSalesContext(sales, Number(shop.fuduoShopId), tradeDate);
          await this.saveSales(shop.id, tradeDate, sales, attemptKey);
        });
        await this.completeItem(syncRunId, "sales", tradeDate, shop.id, shop.fuduoShopId, "SUCCEEDED", attemptKey);
        success += 1;
      } catch (error) {
        const code = errorCode(error);
        await this.completeItem(syncRunId, "sales", tradeDate, shop.id, shop.fuduoShopId, "FAILED", attemptKey, code).catch(() => undefined);
        if (isTerminalSyncError(code)) throw error;
        failures.push(code);
      }
    });
    const status = dailyRunStatus(success, failures.length);
    if (finalizeRun) await this.completeRun(syncRunId, shops.length, success, failures.length, status, failures[0]);
    return { total: shops.length, success, failed: failures.length, status };
  }

  async syncOrders(syncRunId: string, tradeDate: string, requestedShopIds?: string[], finalizeRun = true) {
    const shops = await this.activeShops(requestedShopIds);
    if (!shops.length) throw new Error("SYNC_NO_ACTIVE_SHOPS");
    const initialToken = shops.length ? await this.credentials.getToken() : null;
    let success = 0;
    const failures: string[] = [];
    await mapConcurrent(shops, 3, async (shop) => {
      const attemptKey = await this.startItem(syncRunId, "orders", tradeDate, shop);
      try {
        await this.lease.run(syncLeaseKey("orders", shop.fuduoShopId, tradeDate), async () => {
          const aggregate = await this.withRefresh(
            (accessToken) => collectOrderDaily(this.createClient(accessToken), Number(shop.fuduoShopId), tradeDate),
            initialToken!,
          );
          const fetchedAt = new Date();
          const date = new Date(`${tradeDate}T00:00:00.000Z`);
          const data = {
            orderCount: aggregate.orderCount,
            paidOrderCount: aggregate.paidOrderCount,
            paidAmount: decimal(aggregate.paidAmount),
            source: "FUDUO_OPS_ORDERS",
            fetchedAt,
          };
          await this.prisma.$transaction([
            this.prisma.orderDaily.upsert({
              where: { shopId_tradeDate: { shopId: shop.id, tradeDate: date } },
              create: { shopId: shop.id, tradeDate: date, ...data },
              update: data,
            }),
            this.prisma.shop.update({ where: { id: shop.id }, data: { lastSyncedAt: fetchedAt } }),
            this.successfulStateUpdate(shop.id, "orders", date, attemptKey, data.source, fetchedAt, false),
          ]);
        });
        await this.completeItem(syncRunId, "orders", tradeDate, shop.id, shop.fuduoShopId, "SUCCEEDED", attemptKey);
        success += 1;
      } catch (error) {
        const code = errorCode(error);
        await this.completeItem(syncRunId, "orders", tradeDate, shop.id, shop.fuduoShopId, "FAILED", attemptKey, code).catch(() => undefined);
        if (isTerminalSyncError(code)) throw error;
        failures.push(code);
      }
    });
    return this.finishDailyRun(syncRunId, shops.length, success, failures, finalizeRun);
  }

  async syncRefunds(syncRunId: string, tradeDate: string, requestedShopIds?: string[], finalizeRun = true) {
    const shops = await this.activeShops(requestedShopIds);
    if (!shops.length) throw new Error("SYNC_NO_ACTIVE_SHOPS");
    const initialToken = shops.length ? await this.credentials.getToken() : null;
    let success = 0;
    const failures: string[] = [];
    await mapConcurrent(shops, 3, async (shop) => {
      const attemptKey = await this.startItem(syncRunId, "refunds", tradeDate, shop);
      try {
        await this.lease.run(syncLeaseKey("refunds", shop.fuduoShopId, tradeDate), async () => {
          const aggregate = await this.withRefresh(
            (accessToken) => collectRefundDaily(this.createClient(accessToken), Number(shop.fuduoShopId), tradeDate),
            initialToken!,
          );
          const fetchedAt = new Date();
          const date = new Date(`${tradeDate}T00:00:00.000Z`);
          const data = {
            refundCount: aggregate.refundCount,
            refundAmount: decimal(aggregate.refundAmount),
            source: "FUDUO_OPS_AFTERSALES",
            fetchedAt,
          };
          await this.prisma.$transaction([
            this.prisma.refundDaily.upsert({
              where: { shopId_tradeDate: { shopId: shop.id, tradeDate: date } },
              create: { shopId: shop.id, tradeDate: date, ...data },
              update: data,
            }),
            this.prisma.shop.update({ where: { id: shop.id }, data: { lastSyncedAt: fetchedAt } }),
            this.successfulStateUpdate(shop.id, "refunds", date, attemptKey, data.source, fetchedAt, false),
          ]);
        });
        await this.completeItem(syncRunId, "refunds", tradeDate, shop.id, shop.fuduoShopId, "SUCCEEDED", attemptKey);
        success += 1;
      } catch (error) {
        const code = errorCode(error);
        await this.completeItem(syncRunId, "refunds", tradeDate, shop.id, shop.fuduoShopId, "FAILED", attemptKey, code).catch(() => undefined);
        if (isTerminalSyncError(code)) throw error;
        failures.push(code);
      }
    });
    return this.finishDailyRun(syncRunId, shops.length, success, failures, finalizeRun);
  }

  async reconcileRecent(syncRunId: string, tradeDates: string[], requestedShopIds?: string[]) {
    let total = 0;
    let success = 0;
    let failed = 0;

    for (const tradeDate of tradeDates) {
      const results = [
        await this.syncSales(syncRunId, tradeDate, requestedShopIds, false),
        await this.syncOrders(syncRunId, tradeDate, requestedShopIds, false),
        await this.syncRefunds(syncRunId, tradeDate, requestedShopIds, false),
      ];
      for (const result of results) {
        total += result.total;
        success += result.success;
        failed += result.failed;
      }
    }

    const status = dailyRunStatus(success, failed);
    const code = failed === 0 ? undefined : status === "PARTIAL" ? "SYNC_RECONCILE_PARTIAL" : "SYNC_RECONCILE_FAILED";
    await this.completeRun(syncRunId, total, success, failed, status, code);
    return { total, success, failed, status };
  }

  private async saveSales(shopId: string, tradeDate: string, sales: SalesLive, attemptKey: string) {
    const date = new Date(`${tradeDate}T00:00:00.000Z`);
    const data = {
      salesAmount: decimal(sales.salesAmount),
      transactionCount: integer(sales.transactionCount),
      payBuyerCount: integer(sales.payBuyerCount),
      averageOrderValue: decimal(sales.averageOrderValue),
      refundAmount: null,
      freshness: "LIVE" as const,
      source: "FUDUO_SALES_LIVE",
      sourceUpdatedAt: new Date(),
      fetchedAt: new Date(),
    };
    await this.prisma.$transaction([
      this.prisma.salesDaily.upsert({
        where: { shopId_tradeDate: { shopId, tradeDate: date } },
        create: { shopId, tradeDate: date, ...data },
        update: data,
      }),
      this.prisma.salesSnapshot.create({
        data: {
          shopId,
          tradeDate: date,
          salesAmount: data.salesAmount,
          transactionCount: data.transactionCount,
          refundAmount: data.refundAmount,
          source: data.source,
        },
      }),
      this.prisma.shop.update({ where: { id: shopId }, data: { lastSyncedAt: data.fetchedAt } }),
      this.successfulStateUpdate(
        shopId,
        "sales",
        date,
        attemptKey,
        data.source,
        data.sourceUpdatedAt,
        data.salesAmount === null || data.transactionCount === null,
      ),
    ]);
  }

  private async withRefresh<T>(request: (token: string) => Promise<T>, token: string): Promise<T> {
    try {
      return await request(token);
    } catch (error) {
      if (!(error instanceof FuduoApiError) || (error.status !== 401 && error.code !== "BIZ_UNAUTHORIZED")) throw error;
      const refreshed = await this.credentials.refresh();
      return request(refreshed);
    }
  }

  private activeShops(requestedShopIds?: string[]) {
    return this.prisma.shop.findMany({
      where: {
        status: "ACTIVE",
        ...(requestedShopIds?.length ? { fuduoShopId: { in: requestedShopIds.map((id) => BigInt(id)) } } : {}),
      },
      orderBy: { name: "asc" },
    });
  }

  private async finishDailyRun(syncRunId: string, total: number, success: number, failures: string[], finalizeRun: boolean) {
    const status = dailyRunStatus(success, failures.length);
    if (finalizeRun) await this.completeRun(syncRunId, total, success, failures.length, status, failures[0]);
    return { total, success, failed: failures.length, status };
  }

  private async completeRun(id: string, total: number, success: number, failed: number, status: string, code?: string) {
    await this.prisma.syncRun.update({
      where: { id },
      data: {
        status,
        totalItems: total,
        successItems: success,
        failedItems: failed,
        errorCode: code ?? null,
        errorMessage: code ? "一个或多个店铺同步失败" : null,
        finishedAt: new Date(),
      },
    });
  }

  private async startItem(
    syncRunId: string,
    dataType: SyncDataType,
    tradeDate: string,
    shop: { id: string; fuduoShopId: bigint; name: string },
  ) {
    const date = new Date(`${tradeDate}T00:00:00.000Z`);
    const startedAt = new Date();
    const attemptKey = randomUUID();
    await this.prisma.$transaction([
      this.prisma.syncRunItem.upsert({
        where: { syncRunId_dataType_tradeDate_fuduoShopId: { syncRunId, dataType, tradeDate: date, fuduoShopId: shop.fuduoShopId } },
        create: {
          syncRunId,
          dataType,
          tradeDate: date,
          fuduoShopId: shop.fuduoShopId,
          shopName: shop.name,
          status: "RUNNING",
          startedAt,
        },
        update: {
          shopName: shop.name,
          status: "RUNNING",
          attempt: { increment: 1 },
          errorCode: null,
          errorMessage: null,
          startedAt,
          finishedAt: null,
        },
      }),
      this.prisma.dataSyncState.upsert({
        where: { shopId_dataType_tradeDate: { shopId: shop.id, dataType, tradeDate: date } },
        create: {
          shopId: shop.id,
          dataType,
          tradeDate: date,
          lastAttemptAt: startedAt,
          lastAttemptStatus: "RUNNING",
          source: sourceFor(dataType),
          currentAttemptKey: attemptKey,
        },
        update: {
          lastAttemptAt: startedAt,
          lastAttemptStatus: "RUNNING",
          errorCode: null,
          currentAttemptKey: attemptKey,
        },
      }),
    ]);
    return attemptKey;
  }

  private completeItem(
    syncRunId: string,
    dataType: SyncDataType,
    tradeDate: string,
    shopId: string,
    fuduoShopId: bigint,
    status: "SUCCEEDED" | "FAILED",
    attemptKey: string,
    errorCode?: string,
  ) {
    const date = new Date(`${tradeDate}T00:00:00.000Z`);
    const itemUpdate = this.prisma.syncRunItem.update({
      where: {
        syncRunId_dataType_tradeDate_fuduoShopId: {
          syncRunId,
          dataType,
          tradeDate: date,
          fuduoShopId,
        },
      },
      data: {
        status,
        errorCode: errorCode ?? null,
        errorMessage: errorCode ? "店铺数据同步失败" : null,
        finishedAt: new Date(),
      },
    });
    if (status === "SUCCEEDED") return itemUpdate;
    return this.prisma.$transaction([
      itemUpdate,
      this.prisma.dataSyncState.updateMany({
        where: { shopId, dataType, tradeDate: date, currentAttemptKey: attemptKey },
        data: {
          lastAttemptStatus: "FAILED",
          errorCode: errorCode ?? "SYNC_UNKNOWN",
          currentAttemptKey: null,
        },
      }),
    ]);
  }

  private successfulStateUpdate(
    shopId: string,
    dataType: SyncDataType,
    tradeDate: Date,
    attemptKey: string,
    source: string,
    sourceUpdatedAt: Date,
    partial: boolean,
  ) {
    return this.prisma.dataSyncState.updateMany({
      where: { shopId, dataType, tradeDate, currentAttemptKey: attemptKey },
      data: {
        lastSuccessAt: new Date(),
        lastAttemptStatus: "SUCCEEDED",
        source,
        sourceUpdatedAt,
        partial,
        errorCode: null,
        currentAttemptKey: null,
      },
    });
  }
}

type SyncDataType = "sales" | "orders" | "refunds";

function sourceFor(dataType: SyncDataType) {
  if (dataType === "sales") return "FUDUO_SALES_LIVE";
  if (dataType === "orders") return "FUDUO_OPS_ORDERS";
  return "FUDUO_OPS_AFTERSALES";
}

function dailyRunStatus(success: number, failed: number): "SUCCEEDED" | "PARTIAL" | "FAILED" {
  if (failed === 0) return "SUCCEEDED";
  return success > 0 ? "PARTIAL" : "FAILED";
}

function decimal(value: number | null | undefined): string | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : value.toFixed(2);
}

function integer(value: number | null | undefined): number | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : Math.trunc(value);
}

function errorCode(error: unknown): string {
  if (error instanceof FuduoApiError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) return error.message;
  return "SYNC_UNKNOWN";
}

function syncLeaseKey(type: "sales" | "orders" | "refunds", shopId: bigint, tradeDate: string) {
  return `${type}:${shopId}:${tradeDate}`;
}

function assertSalesContext(sales: SalesLive, shopId: number, tradeDate: string) {
  if (sales.shopId !== shopId || sales.salesStatDate !== tradeDate) {
    throw new FuduoApiError("ERP_SALES_CONTEXT_MISMATCH", "富多销售响应与请求店铺或业务日期不一致", 502);
  }
}

function paginationError(message: string) {
  return new FuduoApiError("ERP_PAGINATION_INVALID", message, 502);
}

async function mapConcurrent<T>(items: T[], concurrency: number, operation: (item: T) => Promise<void>) {
  let cursor = 0;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length && failure === undefined) {
      const index = cursor;
      cursor += 1;
      try {
        await operation(items[index]!);
      } catch (error) {
        failure ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (failure !== undefined) throw failure;
}
