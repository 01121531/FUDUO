import { z } from "zod";

export const freshnessSchema = z.enum(["LIVE", "RECENT", "STALE", "UNKNOWN"]);
export type Freshness = z.infer<typeof freshnessSchema>;

export const credentialStatusSchema = z.enum([
  "UNCONFIGURED",
  "LOGIN_PENDING",
  "ACTIVE",
  "REFRESHING",
  "REAUTH_REQUIRED",
  "REVOKED",
]);
export type CredentialStatus = z.infer<typeof credentialStatusSchema>;

export const shopSchema = z.object({
  id: z.number().int().positive(),
  accountId: z.number().int().positive().nullable(),
  name: z.string().min(1),
  platform: z.string().default("pdd"),
  loginStatus: z.string().nullable(),
  todaySales: z.number().nullable(),
  todayOrders: z.number().int().nullable(),
  refundAmount: z.number().nullable(),
  lastSyncedAt: z.string().datetime().nullable(),
  freshness: freshnessSchema.optional(),
  dataAsOf: z.string().datetime().nullable().optional(),
  lastAttemptAt: z.string().datetime().nullable().optional(),
  source: z.string().nullable().optional(),
  partial: z.boolean().optional(),
});
export type Shop = z.infer<typeof shopSchema>;

export const salesMetricSchema = z.object({
  shopId: z.number().int().positive(),
  shopName: z.string(),
  tradeDate: z.string(),
  salesAmount: z.number().nullable(),
  transactionCount: z.number().int().nullable(),
  payBuyerCount: z.number().int().nullable(),
  averageOrderValue: z.number().nullable(),
  refundAmount: z.number().nullable(),
  freshness: freshnessSchema,
  dataAsOf: z.string().datetime(),
});
export type SalesMetric = z.infer<typeof salesMetricSchema>;

export interface ApiMeta {
  traceId: string;
  dataAsOf?: string;
  freshness?: Freshness;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta: ApiMeta;
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
    recovery?: string;
  };
  meta: Pick<ApiMeta, "traceId">;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export const REPORT_TIMEZONE = "Asia/Shanghai";
export const REPORT_CRON_PATTERN = /^0 (?:[0-5]?\d) (?:[01]?\d|2[0-3]) \* \* (?:\*|[1-7](?:,[1-7])*)$/;

export function isReportCron(value: string) {
  return REPORT_CRON_PATTERN.test(value);
}

export function calculateFreshness(dataAsOf: Date | null, now = new Date()): Freshness {
  if (!dataAsOf) return "UNKNOWN";
  const ageMs = Math.max(0, now.getTime() - dataAsOf.getTime());
  if (ageMs <= 10 * 60_000) return "LIVE";
  if (ageMs <= 60 * 60_000) return "RECENT";
  return "STALE";
}

export function formatCurrency(value: number | null, compact = false): string {
  if (value === null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: compact ? 0 : 2,
    maximumFractionDigits: compact ? 1 : 2,
    notation: compact ? "compact" : "standard",
  }).format(value);
}
