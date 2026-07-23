import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

interface RequestContext {
  traceId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(traceId: string, callback: () => T): T {
  return storage.run({ traceId }, callback);
}

export function currentTraceId(): string {
  return storage.getStore()?.traceId ?? randomUUID();
}

export function normalizeTraceId(value: unknown): string {
  if (typeof value !== "string") return randomUUID();
  const normalized = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : randomUUID();
}
