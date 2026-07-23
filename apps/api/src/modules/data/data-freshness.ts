import { calculateFreshness, type Freshness } from "@fuduo/shared";

export type DataType = "SALES" | "ORDERS" | "REFUNDS";

export interface PersistedDataSyncState {
  dataType: string;
  tradeDate: Date;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date;
  lastAttemptStatus: string;
  source: string | null;
  partial: boolean;
  errorCode: string | null;
}

export interface FreshnessMetadata {
  freshness: Freshness;
  dataAsOf: string | null;
  lastAttemptAt: string | null;
  source: string | null;
  partial: boolean;
  errorCode: string | null;
}

export function resolveDataFreshness(
  states: PersistedDataSyncState[],
  requiredTypes: DataType[],
  startDate: string,
  endDate: string,
  now = new Date(),
) {
  const expectedDates = enumerateDateKeys(startDate, endDate);
  const freshnessByType = Object.fromEntries(requiredTypes.map((dataType) => {
    const typeStates = states.filter((state) => state.dataType.toUpperCase() === dataType);
    return [dataType, resolveType(typeStates, expectedDates, now)];
  })) as Partial<Record<DataType, FreshnessMetadata>>;
  const metadata = requiredTypes.map((type) => freshnessByType[type]!).filter(Boolean);
  return {
    freshness: worstFreshness(metadata.map((item) => item.freshness)),
    dataAsOf: oldestIso(metadata.map((item) => item.dataAsOf)),
    lastAttemptAt: newestIso(metadata.map((item) => item.lastAttemptAt)),
    source: combineSources(metadata.map((item) => item.source)),
    partial: metadata.some((item) => item.partial),
    freshnessByType,
  };
}

function resolveType(states: PersistedDataSyncState[], expectedDates: string[], now: Date): FreshnessMetadata {
  const byDate = new Map(states.map((state) => [dateKey(state.tradeDate), state]));
  const expected = expectedDates.map((date) => byDate.get(date));
  const successes = expected.flatMap((state) => state?.lastSuccessAt ? [state.lastSuccessAt] : []);
  const attempts = expected.flatMap((state) => state ? [state.lastAttemptAt] : []);
  const hasFailureAfterSuccess = expected.some((state) => state?.lastAttemptStatus === "FAILED"
    && (!state.lastSuccessAt || state.lastAttemptAt.getTime() >= state.lastSuccessAt.getTime()));
  const missing = expected.some((state) => !state?.lastSuccessAt);
  const dataAsOf = successes.length ? new Date(Math.min(...successes.map((item) => item.getTime()))) : null;
  const freshness = missing ? "UNKNOWN" : hasFailureAfterSuccess ? "STALE" : calculateFreshness(dataAsOf, now);
  const sources = expected.map((state) => state?.source ?? null);
  const failure = [...expected]
    .reverse()
    .find((state) => state?.lastAttemptStatus === "FAILED" && state.errorCode);
  return {
    freshness,
    dataAsOf: dataAsOf?.toISOString() ?? null,
    lastAttemptAt: attempts.length ? new Date(Math.max(...attempts.map((item) => item.getTime()))).toISOString() : null,
    source: combineSources(sources),
    partial: missing || expected.some((state) => state?.partial === true || state?.lastAttemptStatus === "FAILED"),
    errorCode: failure?.errorCode ?? null,
  };
}

function enumerateDateKeys(start: string, end: string) {
  const dates: string[] = [];
  let cursor = new Date(`${start}T00:00:00.000Z`);
  const finish = new Date(`${end}T00:00:00.000Z`);
  while (cursor <= finish) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function combineSources(values: Array<string | null>) {
  const sources = [...new Set(values.filter((value): value is string => Boolean(value)))];
  return sources.length === 0 ? null : sources.length === 1 ? sources[0]! : "MULTIPLE";
}

function oldestIso(values: Array<string | null>) {
  const times = values.filter((value): value is string => Boolean(value)).map((value) => new Date(value).getTime());
  return times.length ? new Date(Math.min(...times)).toISOString() : null;
}

function newestIso(values: Array<string | null>) {
  const times = values.filter((value): value is string => Boolean(value)).map((value) => new Date(value).getTime());
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function worstFreshness(values: Freshness[]): Freshness {
  if (!values.length) return "UNKNOWN";
  const order: Freshness[] = ["LIVE", "RECENT", "STALE", "UNKNOWN"];
  return values.reduce((worst, value) => order.indexOf(value) > order.indexOf(worst) ? value : worst, "LIVE");
}
