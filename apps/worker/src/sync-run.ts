import type { SalesSyncPayload } from "./queue.js";
import { syncRunPayload } from "./sync-job-data.js";

interface SyncJobState {
  name: string;
  data: SalesSyncPayload;
  updateData(data: SalesSyncPayload): Promise<void>;
}

interface SyncRunStore {
  create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<{ id: string }>;
}

export async function beginSyncRun(job: SyncJobState, store: SyncRunStore) {
  const startedAt = new Date();
  if (job.data.syncRunId) {
    return store.update({
      where: { id: job.data.syncRunId },
      data: {
        status: "RUNNING",
        startedAt,
        finishedAt: null,
        errorCode: null,
        errorMessage: null,
        payload: syncRunPayload(job.data),
      },
    });
  }

  const run = await store.create({
    data: { type: job.name, status: "RUNNING", startedAt, requestedBy: "worker", payload: syncRunPayload(job.data) },
  });
  try {
    await job.updateData({ ...job.data, syncRunId: run.id });
  } catch (error) {
    await store.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        errorCode: "SYNC_JOB_STATE_PERSIST_FAILED",
        errorMessage: "同步任务状态持久化失败",
        finishedAt: new Date(),
      },
    }).catch(() => undefined);
    throw error;
  }
  return run;
}
