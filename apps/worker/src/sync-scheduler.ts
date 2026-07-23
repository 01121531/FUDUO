import type { Queue } from "bullmq";
import { retryableJobOptions } from "./queue.js";

type SchedulerQueue = Pick<Queue, "removeJobScheduler" | "upsertJobScheduler">;

const retiredSchedulers = ["orders-every-15m", "refunds-every-15m"] as const;

const coreSchedulers = [
  { id: "shop-catalog-every-10m", repeat: { every: 10 * 60_000 }, name: "shop-catalog-sync" },
  { id: "credential-refresh-check-every-10m", repeat: { every: 10 * 60_000 }, name: "credential-refresh" },
  { id: "sales-live-every-5m", repeat: { every: 5 * 60_000 }, name: "sales-live-sync" },
  { id: "orders-every-5m", repeat: { every: 5 * 60_000 }, name: "orders-sync" },
  { id: "refunds-every-5m", repeat: { every: 5 * 60_000 }, name: "refunds-sync" },
  { id: "sales-reconcile-daily", repeat: { pattern: "0 15 2 * * *", tz: "Asia/Shanghai" }, name: "sales-reconcile" },
] as const;

export async function ensureCoreSyncSchedulers(queue: SchedulerQueue) {
  for (const schedulerId of retiredSchedulers) {
    await queue.removeJobScheduler(schedulerId);
  }
  for (const scheduler of coreSchedulers) {
    await queue.upsertJobScheduler(
      scheduler.id,
      scheduler.repeat,
      { name: scheduler.name, data: {}, opts: retryableJobOptions() },
    );
  }
  return { configured: coreSchedulers.length };
}
