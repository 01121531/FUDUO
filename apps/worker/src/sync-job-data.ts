import type { SalesSyncPayload, SyncJobName } from "./queue.js";
import { recentBusinessDates, shanghaiBusinessDate } from "./business-dates.js";

interface MutableSyncJob {
  name: SyncJobName;
  data: SalesSyncPayload;
  updateData(data: SalesSyncPayload): Promise<void>;
}

export async function prepareSyncJobData(job: MutableSyncJob, now = new Date()) {
  let next = job.data;
  if (["sales-live-sync", "orders-sync", "refunds-sync"].includes(job.name) && !next.tradeDate) {
    next = { ...next, tradeDate: shanghaiBusinessDate(now) };
  }
  if (job.name === "sales-reconcile" && !next.tradeDates?.length) {
    next = { ...next, tradeDates: recentBusinessDates(7, now) };
  }
  if (next === job.data) return next;
  await job.updateData(next);
  job.data = next;
  return next;
}

export async function prepareSyncShopScope(job: MutableSyncJob, activeShopIds: () => Promise<string[]>) {
  if (!["sales-live-sync", "sales-reconcile", "orders-sync", "refunds-sync"].includes(job.name)) return job.data;
  if (job.data.shopIds !== undefined) {
    if (!job.data.shopIds.length) throw new Error("SYNC_NO_ACTIVE_SHOPS");
    return job.data;
  }
  const shopIds = await activeShopIds();
  if (!shopIds.length) throw new Error("SYNC_NO_ACTIVE_SHOPS");
  const next = { ...job.data, shopIds };
  await job.updateData(next);
  job.data = next;
  return next;
}

export function syncRunPayload(data: SalesSyncPayload) {
  return {
    ...(data.sourceRunId ? { sourceRunId: data.sourceRunId } : {}),
    ...(data.tradeDate ? { tradeDate: data.tradeDate } : {}),
    ...(data.tradeDates?.length ? { tradeDates: data.tradeDates } : {}),
    ...(data.shopIds?.length ? { shopIds: data.shopIds } : {}),
  };
}
