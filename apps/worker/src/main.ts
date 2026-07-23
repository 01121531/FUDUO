import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { createPrismaClient } from "@fuduo/database";
import { CredentialProvider } from "./credential-provider.js";
import { SYNC_QUEUE, type SalesSyncPayload, type SyncJobName } from "./queue.js";
import { SyncService } from "./sync-service.js";
import { ensureCoreSyncSchedulers } from "./sync-scheduler.js";
import { ensureDefaultReportSchedules, reconcileReportSchedulers } from "./report-scheduler.js";
import { enqueueReportDeliveries, executeReportDelivery, reconcileQueuedReportDeliveries, requestReportGeneration } from "./report-api.js";
import { findReportRefreshPlan, refreshReportDataGroups, REPORT_REFRESH_MAX_AGE_MS, type ReportRefreshGroup } from "./report-data-refresh.js";
import { validateWorkerEnvironment } from "@fuduo/shared/environment";
import { createWorkerHealthServer } from "./health-server.js";
import { recentBusinessDates, shanghaiBusinessDate } from "./business-dates.js";
import { RedisSyncLease } from "./sync-lease.js";
import { isTerminalSyncError, retryIncompleteSync, SyncRetryRequested, type SyncAttemptResult } from "./sync-retry.js";
import { beginSyncRun } from "./sync-run.js";
import { notifyErpReauthRequired } from "./credential-alert.js";
import { prepareSyncJobData, prepareSyncShopScope, syncRunPayload } from "./sync-job-data.js";

validateWorkerEnvironment();

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required for the worker");

const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const prisma = createPrismaClient();
const credentials = new CredentialProvider(prisma, connection, (credentialVersion) =>
  notifyErpReauthRequired(connection, credentialVersion));
const sync = new SyncService(prisma, credentials, undefined, new RedisSyncLease(connection));
const queue = new Queue(SYNC_QUEUE, { connection });

await ensureCoreSyncSchedulers(queue);

await ensureDefaultReportSchedules(prisma);
await reconcileReportSchedulers(prisma, queue);
const reportScheduleTimer = setInterval(() => void reconcileReportSchedulers(prisma, queue).catch((error) => log("error", "report-schedules.reconcile-failed", { code: errorCode(error) })), 60_000);
reportScheduleTimer.unref();
await reconcileQueuedReportDeliveries(prisma, queue);
const reportDeliveryTimer = setInterval(() => void reconcileQueuedReportDeliveries(prisma, queue).catch((error) => log("error", "report-deliveries.reconcile-failed", { code: errorCode(error) })), 60_000);
reportDeliveryTimer.unref();
const worker = new Worker<SalesSyncPayload, unknown, SyncJobName>(
  SYNC_QUEUE,
  async (job: Job<SalesSyncPayload, unknown, SyncJobName>) => {
    if (job.name === "channel-delivery") {
      if (!job.data.reportDeliveryId) throw new Error("REPORT_DELIVERY_ID_REQUIRED");
      return executeReportDelivery(job.data.reportDeliveryId);
    }
    await prepareSyncJobData(job);
    const run = await beginSyncRun(job, prisma.syncRun);
    try {
      await prepareSyncShopScope(job, async () => (await prisma.shop.findMany({
        where: { status: "ACTIVE" },
        select: { fuduoShopId: true },
        orderBy: { fuduoShopId: "asc" },
      })).map((shop) => String(shop.fuduoShopId)));
      await prisma.syncRun.update({ where: { id: run.id }, data: { payload: syncRunPayload(job.data) } });
      if (job.name === "shop-catalog-sync") return await sync.syncShops(run.id);
      if (job.name === "credential-refresh") {
        const refreshed = await credentials.refreshIfNeeded();
        await prisma.syncRun.update({ where: { id: run.id }, data: { status: "SUCCEEDED", totalItems: 1, successItems: 1, finishedAt: new Date() } });
        return { refreshed };
      }
      if (job.name === "orders-sync") {
        return await settleSyncAttempt(job, run.id, await sync.syncOrders(run.id, job.data.tradeDate ?? shanghaiBusinessDate(), job.data.shopIds));
      }
      if (job.name === "refunds-sync") {
        return await settleSyncAttempt(job, run.id, await sync.syncRefunds(run.id, job.data.tradeDate ?? shanghaiBusinessDate(), job.data.shopIds));
      }
      if (job.name === "sales-reconcile") {
        return await settleSyncAttempt(job, run.id, await sync.reconcileRecent(run.id, job.data.tradeDates ?? recentBusinessDates(7), job.data.shopIds));
      }
      if (job.name === "report-generate") {
        const type = job.data.reportType ?? "DAILY";
        const reportNow = new Date(job.timestamp);
        const target = await findReportRefreshPlan(prisma, type, job.data.shopIds, reportNow, REPORT_REFRESH_MAX_AGE_MS, new Date());
        const refreshed = await refreshReportData(target.groups, job.data.scheduledReportId);
        const remaining = await findReportRefreshPlan(prisma, type, job.data.shopIds, reportNow, REPORT_REFRESH_MAX_AGE_MS, new Date());
        const result = await generateReport(type, job.data.shopIds, job.data.scheduledReportId, target.period.startDate);
        await enqueueReportDeliveries(queue, result);
        const partial = refreshed.failed > 0 || remaining.groups.length > 0 || result.partial === true;
        await prisma.syncRun.update({ where: { id: run.id }, data: { status: partial ? "PARTIAL" : "SUCCEEDED", totalItems: 1, successItems: partial ? 0 : 1, failedItems: partial ? 1 : 0, finishedAt: new Date() } });
        return result;
      }
      return await settleSyncAttempt(job, run.id, await sync.syncSales(run.id, job.data.tradeDate ?? shanghaiBusinessDate(), job.data.shopIds));
    } catch (error) {
      if (error instanceof SyncRetryRequested) throw error;
      const code = taskErrorCode(error, "SYNC_FAILED");
      await prisma.syncRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          errorCode: code,
          errorMessage: "同步任务执行失败",
          finishedAt: new Date(),
        },
      });
      if (isTerminalSyncError(code)) throw new UnrecoverableError(code);
      throw error;
    }
  },
  { connection, concurrency: 3 },
);

const healthServer = createWorkerHealthServer({
  workerRunning: () => worker.isRunning(),
  postgresPing: () => prisma.$queryRawUnsafe("SELECT 1").then(() => true).catch(() => false),
  redisPing: () => connection.ping().then((value) => value === "PONG").catch(() => false),
});
const healthHost = process.env.WORKER_HEALTH_HOST ?? "127.0.0.1";
const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 3002);
await new Promise<void>((resolve, reject) => {
  healthServer.once("error", reject);
  healthServer.listen(healthPort, healthHost, () => {
    healthServer.removeListener("error", reject);
    resolve();
  });
});

worker.on("completed", (job) => log("info", "sync.completed", { jobId: job.id, name: job.name }));
worker.on("failed", (job) => log("error", "sync.failed", { jobId: job?.id, name: job?.name }));
log("info", "worker.started", { queue: SYNC_QUEUE, healthHost, healthPort });

async function shutdown() {
  clearInterval(reportScheduleTimer);
  clearInterval(reportDeliveryTimer);
  await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  await worker.close();
  await queue.close();
  await connection.quit();
  await prisma.$disconnect();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

function log(level: "info" | "error", event: string, fields: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ level, event, ...fields, at: new Date().toISOString() })}\n`);
}

async function generateReport(type: "DAILY" | "WEEKLY", shopIds?: string[], scheduledReportId?: string, periodStart?: string) {
  return requestReportGeneration(type, shopIds, scheduledReportId, periodStart);
}

async function refreshReportData(groups: ReportRefreshGroup[], scheduledReportId?: string) {
  if (!groups.length) return { total: 0, success: 0, failed: 0, failedGroups: [] };
  const refreshRun = await prisma.syncRun.create({
    data: { type: "report-data-refresh", status: "RUNNING", startedAt: new Date(), requestedBy: scheduledReportId ?? "report-generate" },
  });
  const refreshed = await refreshReportDataGroups(groups, {
    SALES: (tradeDate, shopIds) => sync.syncSales(refreshRun.id, tradeDate, shopIds, false),
    ORDERS: (tradeDate, shopIds) => sync.syncOrders(refreshRun.id, tradeDate, shopIds, false),
    REFUNDS: (tradeDate, shopIds) => sync.syncRefunds(refreshRun.id, tradeDate, shopIds, false),
  });
  const status = refreshed.failed === 0 ? "SUCCEEDED" : refreshed.success > 0 ? "PARTIAL" : "FAILED";
  await prisma.syncRun.update({
    where: { id: refreshRun.id },
    data: {
      status,
      totalItems: refreshed.total,
      successItems: refreshed.success,
      failedItems: refreshed.failed,
      errorCode: refreshed.failed ? "REPORT_DATA_REFRESH_PARTIAL" : null,
      errorMessage: refreshed.failed ? "报表数据预刷新未全部成功" : null,
      payload: { requestedGroups: groups.length, failedGroups: refreshed.failedGroups.length },
      finishedAt: new Date(),
    },
  });
  return refreshed;
}

function errorCode(error: unknown) { return error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "REPORT_SCHEDULE_RECONCILE_FAILED"; }
function taskErrorCode(error: unknown, fallback: string) { return error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : fallback; }

function settleSyncAttempt(job: Job<SalesSyncPayload, unknown, SyncJobName>, runId: string, result: SyncAttemptResult) {
  return retryIncompleteSync(runId, result, job.attemptsMade, job.opts.attempts, (args) => prisma.syncRun.update(args as never));
}
