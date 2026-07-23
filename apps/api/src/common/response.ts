import type { ApiSuccess, Freshness } from "@fuduo/shared";
import { currentTraceId } from "./request-context.js";

export function ok<T>(data: T, meta: { dataAsOf?: string; freshness?: Freshness } = {}): ApiSuccess<T> {
  return {
    success: true,
    data,
    meta: { traceId: currentTraceId(), ...meta },
  };
}
