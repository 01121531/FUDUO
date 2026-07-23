const TERMINAL_FAILURES = new Set(["FAILED", "PARTIAL"]);
const RETRYABLE_TYPES = new Set(["shop-catalog-sync", "sales-live-sync", "sales-reconcile", "orders-sync", "refunds-sync", "credential-refresh"]);

export interface RunPayload {
  sourceRunId?: string;
  tradeDate?: string;
  tradeDates?: string[];
  shopIds?: string[];
}

export interface RunItem {
  id: string;
  dataType: string;
  tradeDate: string;
  fuduoShopId: string;
  shopName: string;
  status: string;
  attempt: number;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface Run {
  id: string;
  type: string;
  status: string;
  requestedBy?: string | null;
  total: number;
  success: number;
  failed: number;
  payload: RunPayload;
  scopeAllShops?: boolean;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  items?: RunItem[];
}

export function groupRunItems(items: RunItem[]) {
  const groups = new Map<string, RunItem[]>();
  for (const item of items) groups.set(item.tradeDate, [...(groups.get(item.tradeDate) ?? []), item]);
  const typeOrder = ["sales", "orders", "refunds"];
  return [...groups.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([tradeDate, dateItems]) => ({
      tradeDate,
      summaries: [...new Set(dateItems.map((item) => item.dataType))]
        .sort((left, right) => typeOrder.indexOf(left) - typeOrder.indexOf(right))
        .map((dataType) => {
          const typeItems = dateItems.filter((item) => item.dataType === dataType);
          return {
            dataType,
            total: typeItems.length,
            success: typeItems.filter((item) => item.status === "SUCCEEDED").length,
            failed: typeItems.filter((item) => item.status === "FAILED").length,
          };
        }),
      failures: dateItems.filter((item) => item.status === "FAILED"),
    }));
}

export function isRetryable(run: Run) {
  if (!TERMINAL_FAILURES.has(run.status) || !RETRYABLE_TYPES.has(run.type)) return false;
  if (run.errorCode === "ERP_REAUTH_REQUIRED" || run.errorCode === "ERP_TOKEN_MISSING") return false;
  if (["sales-live-sync", "orders-sync", "refunds-sync"].includes(run.type) && !run.payload.tradeDate) return false;
  if (run.type === "sales-reconcile" && !run.payload.tradeDates?.length) return false;
  return true;
}

export function formatDuration(value: number | null) {
  if (value === null) return "—";
  if (value < 1_000) return `${value} 毫秒`;
  if (value < 60_000) return `${(value / 1_000).toFixed(2)} 秒`;
  const totalSeconds = Math.floor(value / 1_000);
  return `${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒`;
}

export function latestSuccessfulRun(runs: Run[]) {
  return runs
    .filter((run) => run.status === "SUCCEEDED" && run.finishedAt)
    .sort((left, right) => new Date(right.finishedAt!).getTime() - new Date(left.finishedAt!).getTime())[0];
}
