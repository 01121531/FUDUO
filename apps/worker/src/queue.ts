import { Queue, Worker, type Processor } from "bullmq";
import type IORedis from "ioredis";

export const SYNC_QUEUE = "fuduo-sync";

export type SyncJobName = "shop-catalog-sync" | "sales-live-sync" | "sales-reconcile" | "orders-sync" | "refunds-sync" | "credential-refresh" | "report-generate" | "channel-delivery";

export interface SalesSyncPayload {
  syncRunId?: string;
  sourceRunId?: string;
  tradeDate?: string;
  tradeDates?: string[];
  shopIds?: string[];
  reportType?: "DAILY" | "WEEKLY";
  scheduledReportId?: string;
  reportDeliveryId?: string;
}

export function retryableJobOptions() {
  return {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 2_000 },
    removeOnComplete: 200,
    removeOnFail: 500,
  };
}

export function createSyncQueue(connection: IORedis, queueName = SYNC_QUEUE) {
  return new Queue<SalesSyncPayload, unknown, SyncJobName>(queueName, { connection });
}

export function createSyncWorker(
  connection: IORedis,
  processor: Processor<SalesSyncPayload, unknown, SyncJobName>,
  options: { queueName?: string; concurrency?: number } = {},
) {
  return new Worker<SalesSyncPayload, unknown, SyncJobName>(
    options.queueName ?? SYNC_QUEUE,
    processor,
    { connection, concurrency: options.concurrency ?? 3 },
  );
}
