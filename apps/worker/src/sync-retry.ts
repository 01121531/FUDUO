export interface SyncAttemptResult {
  total: number;
  success: number;
  failed: number;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
}

export class SyncRetryRequested extends Error {
  constructor() {
    super("SYNC_RETRY_PENDING");
    this.name = "SyncRetryRequested";
  }
}

export function isTerminalSyncError(code: string) {
  return code === "ERP_REAUTH_REQUIRED" || code === "ERP_TOKEN_MISSING";
}

export async function recordSyncFailure(
  runId: string,
  code: string,
  attemptsMade: number,
  maximumAttempts: number | undefined,
  update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>,
) {
  const retrying = !isTerminalSyncError(code) && attemptsMade + 1 < normalizeMaximumAttempts(maximumAttempts);
  await update({
    where: { id: runId },
    data: {
      status: retrying ? "RETRY_WAIT" : "FAILED",
      errorCode: code,
      errorMessage: "同步任务执行失败",
      finishedAt: retrying ? null : new Date(),
    },
  });
  return { retrying };
}

export async function retryIncompleteSync(
  runId: string,
  result: SyncAttemptResult,
  attemptsMade: number,
  maximumAttempts: number | undefined,
  update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>,
) {
  const maximum = normalizeMaximumAttempts(maximumAttempts);
  const currentAttempt = attemptsMade + 1;
  if (result.failed === 0 || currentAttempt >= maximum) return result;

  await update({
    where: { id: runId },
    data: {
      status: "RETRY_WAIT",
      totalItems: result.total,
      successItems: result.success,
      failedItems: result.failed,
      errorCode: "SYNC_PARTIAL_RETRY",
      errorMessage: `同步未全部成功，等待第 ${currentAttempt + 1}/${maximum} 次尝试`,
      finishedAt: null,
    },
  });
  throw new SyncRetryRequested();
}

function normalizeMaximumAttempts(value: number | undefined) {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 1;
}
