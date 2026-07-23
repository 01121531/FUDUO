import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { DatabaseService } from "../database/database.service.js";
import { DemoDataService } from "../demo/demo-data.service.js";

const SYNC_QUEUE = "fuduo-sync";
const SYNC_TYPES = new Set(["shop-catalog-sync", "sales-live-sync", "sales-reconcile", "orders-sync", "refunds-sync", "credential-refresh"]);
const DAILY_TYPES = new Set(["sales-live-sync", "orders-sync", "refunds-sync"]);
const SHOP_SCOPED_TYPES = new Set(["sales-live-sync", "sales-reconcile", "orders-sync", "refunds-sync"]);

interface SyncJobPayload {
  syncRunId: string;
  sourceRunId?: string;
  tradeDate?: string;
  tradeDates?: string[];
  shopIds?: string[];
}

@Injectable()
export class SyncQueueService implements OnApplicationShutdown, OnModuleInit {
  private connection: IORedis | null = null;
  private queue: Queue | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional() @Inject(DemoDataService) private readonly demo?: DemoDataService,
  ) {}

  onModuleInit() {
    if (!this.database.enabled) return;
    void this.reconcileQueuedRuns().catch(() => undefined);
    this.reconcileTimer = setInterval(() => {
      void this.reconcileQueuedRuns().catch(() => undefined);
    }, 30_000);
    this.reconcileTimer.unref();
  }

  async enqueue(type: string, tradeDate?: string, shopIds?: string[], requestedBy = "web") {
    if (!SYNC_TYPES.has(type)) throw new Error("SYNC_TYPE_UNSUPPORTED");
    if (tradeDate && !isBusinessDate(tradeDate)) throw new Error("SYNC_TRADE_DATE_INVALID");
    if (shopIds && (shopIds.length > 50 || shopIds.some((id) => !/^\d{1,19}$/.test(id)))) throw new Error("SYNC_SHOP_IDS_INVALID");
    if (shopIds?.length === 0) throw new BadRequestException("当前账号没有可同步的店铺");
    if (!this.database.enabled) {
      if (this.demo) return this.demo.enqueueSyncRun(type, tradeDate, shopIds, requestedBy);
      return { id: crypto.randomUUID(), type, status: "QUEUED", createdAt: new Date().toISOString(), demo: true };
    }
    const resolvedShopIds = normalizeIds(shopIds ?? (SHOP_SCOPED_TYPES.has(type)
      ? (await this.database.prisma.shop.findMany({
          where: { status: "ACTIVE" },
          select: { fuduoShopId: true },
          orderBy: { fuduoShopId: "asc" },
        })).map((shop) => String(shop.fuduoShopId))
      : undefined));
    if (SHOP_SCOPED_TYPES.has(type) && !resolvedShopIds?.length) throw new BadRequestException("没有可同步的有效店铺");
    const resolvedTradeDate = DAILY_TYPES.has(type) ? tradeDate ?? shanghaiBusinessDate() : tradeDate;
    const payload = {
      ...(resolvedTradeDate ? { tradeDate: resolvedTradeDate } : {}),
      ...(type === "sales-reconcile" ? { tradeDates: recentBusinessDates(7) } : {}),
      ...(resolvedShopIds ? { shopIds: resolvedShopIds } : {}),
    };
    return this.enqueuePayload(type, payload, requestedBy);
  }

  async retry(runId: string, scopedShopIds: string[] | undefined, requestedBy: string) {
    if (!this.database.enabled) {
      if (this.demo) {
        const retried = this.demo.retrySyncRun(runId, scopedShopIds, requestedBy);
        if (!retried) throw new NotFoundException("同步任务不存在");
        return retried;
      }
      return { id: crypto.randomUUID(), type: "sales-live-sync", status: "QUEUED", createdAt: new Date().toISOString(), demo: true, sourceRunId: runId };
    }
    const original = await this.database.prisma.syncRun.findUnique({ where: { id: runId } });
    if (!original) throw new NotFoundException("同步任务不存在");
    if (!SYNC_TYPES.has(original.type)) throw new BadRequestException("此任务类型不支持手动重试");
    if (!['FAILED', 'PARTIAL'].includes(original.status)) throw new ConflictException("任务尚未结束或无需重试");
    if (original.errorCode === "ERP_REAUTH_REQUIRED" || original.errorCode === "ERP_TOKEN_MISSING") {
      throw new ConflictException("富多授权失效，请重新扫码后再同步");
    }
    if (scopedShopIds?.length === 0) throw new BadRequestException("当前账号没有可重试的店铺");

    const payload = parseStoredPayload(original.payload);
    if (DAILY_TYPES.has(original.type) && !payload.tradeDate) throw new BadRequestException("旧任务缺少业务日期，无法精确重试");
    if (original.type === "sales-reconcile" && !payload.tradeDates?.length) throw new BadRequestException("旧校正任务缺少业务日期，无法精确重试");
    const jobPayload = {
      ...payload,
      sourceRunId: original.id,
      ...(scopedShopIds ? { shopIds: scopedShopIds } : {}),
    };
    const retried = await this.enqueuePayload(original.type, jobPayload, requestedBy);
    return { ...retried, sourceRunId: original.id };
  }

  async status() {
    if (!this.database.enabled) return this.demo?.syncQueueStatus() ?? { connected: false, demoMode: true, queueLength: 0, active: 0, failed: 0 };
    try {
      const counts = await this.getQueue().getJobCounts("waiting", "active", "delayed", "failed");
      return {
        connected: true,
        queueLength: (counts.waiting ?? 0) + (counts.delayed ?? 0),
        active: counts.active ?? 0,
        failed: counts.failed ?? 0,
      };
    } catch {
      return { connected: false, queueLength: 0, active: 0, failed: 0 };
    }
  }

  private async enqueuePayload(type: string, payload: Omit<SyncJobPayload, "syncRunId">, requestedBy: string) {
    const normalizedPayload = normalizePayload(payload);
    const payloadKey = stablePayloadKey(normalizedPayload);
    const claimed = await this.database.prisma.$transaction(async (transaction) => {
      await transaction.$queryRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        type,
        payloadKey,
      );
      const existing = await transaction.syncRun.findFirst({
        where: {
          type,
          status: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] },
          payload: { equals: normalizedPayload },
        },
        orderBy: { createdAt: "desc" },
      });
      if (existing) return { run: existing, deduplicated: true };
      const run = await transaction.syncRun.create({
        data: { type, status: "QUEUED", requestedBy, payload: normalizedPayload },
      });
      return { run, deduplicated: false };
    });

    const { run, deduplicated } = claimed;
    if (deduplicated) {
      if (run.status === "QUEUED") await this.ensureQueuedJob(run.id, type, normalizedPayload);
      return { id: run.id, type, status: run.status, createdAt: run.createdAt.toISOString(), deduplicated: true };
    }
    try {
      await this.ensureQueuedJob(run.id, type, normalizedPayload);
    } catch (error) {
      await this.database.prisma.syncRun.update({
        where: { id: run.id },
        data: { status: "QUEUED", errorCode: "SYNC_QUEUE_UNAVAILABLE", errorMessage: "Queue unavailable; waiting for automatic recovery", finishedAt: null },
      });
      throw error;
    }
    return { id: run.id, type, status: "QUEUED", createdAt: run.createdAt.toISOString() };
  }

  async onApplicationShutdown() {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.queue) await this.queue.close();
    if (this.connection) await this.connection.quit();
  }

  async ping(): Promise<boolean> {
    if (!this.database.enabled) return false;
    const ping = this.getConnection().ping().then((value) => value === "PONG").catch(() => false);
    return Promise.race([ping, delay(false, 2_000)]);
  }

  private getQueue() {
    if (this.queue) return this.queue;
    this.queue = new Queue(SYNC_QUEUE, { connection: this.getConnection() });
    return this.queue;
  }

  private async ensureQueuedJob(runId: string, type: string, payload: Omit<SyncJobPayload, "syncRunId">) {
    await this.getQueue().add(type, {
      syncRunId: runId,
      ...payload,
    }, {
      jobId: `manual-${runId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
  }

  private async reconcileQueuedRuns() {
    const runs = await this.database.prisma.syncRun.findMany({
      where: { status: "QUEUED" },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    for (const run of runs) {
      if (!SYNC_TYPES.has(run.type)) continue;
      const payload = normalizePayload(parseStoredPayload(run.payload));
      await this.ensureQueuedJob(run.id, run.type, payload);
      if (run.errorCode === "SYNC_QUEUE_UNAVAILABLE") {
        await this.database.prisma.syncRun.update({
          where: { id: run.id },
          data: { errorCode: null, errorMessage: null },
        });
      }
    }
  }

  private getConnection() {
    if (this.connection) return this.connection;
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new Error("REDIS_URL is required when DEMO_MODE=false");
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.connection.on("error", () => undefined);
    return this.connection;
  }
}

function normalizePayload(payload: Omit<SyncJobPayload, "syncRunId">): Omit<SyncJobPayload, "syncRunId"> {
  return {
    ...(payload.sourceRunId ? { sourceRunId: payload.sourceRunId } : {}),
    ...(payload.tradeDate ? { tradeDate: payload.tradeDate } : {}),
    ...(payload.tradeDates?.length ? { tradeDates: [...new Set(payload.tradeDates)].sort() } : {}),
    ...(payload.shopIds?.length ? { shopIds: normalizeIds(payload.shopIds) ?? [] } : {}),
  };
}

function normalizeIds(ids: string[] | undefined) {
  return ids ? [...new Set(ids)].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0) : undefined;
}

function stablePayloadKey(payload: Omit<SyncJobPayload, "syncRunId">) {
  return JSON.stringify(payload);
}

function parseStoredPayload(value: unknown): Omit<SyncJobPayload, "syncRunId"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const sourceRunId = typeof input.sourceRunId === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(input.sourceRunId) ? input.sourceRunId : undefined;
  const tradeDate = typeof input.tradeDate === "string" && isBusinessDate(input.tradeDate) ? input.tradeDate : undefined;
  const tradeDates = Array.isArray(input.tradeDates)
    ? input.tradeDates.filter((item): item is string => typeof item === "string" && isBusinessDate(item)).slice(0, 31)
    : undefined;
  const shopIds = Array.isArray(input.shopIds)
    ? input.shopIds.filter((item): item is string => typeof item === "string" && /^\d{1,19}$/.test(item)).slice(0, 50)
    : undefined;
  return {
    ...(sourceRunId ? { sourceRunId } : {}),
    ...(tradeDate ? { tradeDate } : {}),
    ...(tradeDates?.length ? { tradeDates } : {}),
    ...(shopIds?.length ? { shopIds } : {}),
  };
}

function isBusinessDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function delay<T>(value: T, ms: number) {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    timer.unref();
  });
}

function shanghaiBusinessDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function recentBusinessDates(days: number, now = new Date()) {
  const current = new Date(`${shanghaiBusinessDate(now)}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(current);
    date.setUTCDate(current.getUTCDate() - index);
    return date.toISOString().slice(0, 10);
  });
}
