import { z } from "zod";

export const envelopeSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    success: z.boolean(),
    code: z.string().optional(),
    message: z.string().optional(),
    data: data.optional(),
    traceId: z.string().optional(),
  });

export const qrLoginSchema = z.object({
  url: z.string().url(),
  state: z.string().min(1),
  redirectUri: z.string().url(),
});

export const qrLoginPollSchema = z.object({
  pollStatus: z.string().min(1),
  login: z
    .object({
      accessToken: z.string().min(1).nullish(),
      name: z.string().nullish(),
      disableReason: z.string().nullish(),
    })
    .passthrough()
    .nullish(),
});

export const meSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  name: z.string().optional(),
  nickname: z.string().optional(),
  phoneVerified: z.boolean().optional(),
}).passthrough();

export const visibleShopSchema = z
  .object({
    id: z.number().int().positive(),
    accountId: z.number().int().positive().nullish(),
    shopName: z.string().optional(),
    name: z.string().optional(),
    platformCode: z.string().optional(),
    loginStatus: z.union([z.string(), z.number()]).nullish(),
  })
  .passthrough();

export const visibleShopPageSchema = z.object({
  records: z.array(visibleShopSchema).default([]),
  total: z.number().optional(),
  pages: z.number().optional(),
  current: z.number().optional(),
  size: z.number().optional(),
});

const nullableNumber = z.preprocess(parseNullableNumber, z.number().finite().nullable());
const nullableCount = z.preprocess(parseNullableNumber, z.number().int().nonnegative().nullable());

export const salesLiveSchema = z
  .object({
    shopId: z.coerce.number().int().positive(),
    salesStatDate: z.string().nullish(),
    salesAmount: nullableNumber,
    transactionCount: nullableCount,
    payBuyerCount: nullableCount,
    conversionRate: nullableNumber,
    averageOrderValue: nullableNumber,
    repeatBuyerRate: nullableNumber,
    yesterdayFollowerCount: nullableCount,
    yesterdayRefundAmount: nullableNumber,
    yesterdayRefundCount: nullableCount,
    yesterdayVisitorValue: nullableNumber,
    status: z.string().nullish(),
    message: z.string().nullish(),
  })
  .passthrough();

export const opsOrderSchema = z.object({
  businessShopId: z.coerce.number().int().positive().optional(),
  platformOrderId: z.string().nullish(),
  payAmount: nullableNumber,
  orderStatus: z.union([z.string(), z.number()]).nullish(),
  platformOccurredAt: z.string().nullish(),
}).passthrough();

export const opsAfterSalesSchema = z.object({
  businessShopId: z.coerce.number().int().positive().optional(),
  platformRefundId: z.string().nullish(),
  platformOrderId: z.string().nullish(),
  refundAmount: nullableNumber,
  performanceImpact: nullableNumber,
  platformOccurredAt: z.string().nullish(),
}).passthrough();

const pageNumber = z.coerce.number().int().nonnegative().optional();

function parseNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return value;
}

export const opsOrderPageSchema = z.object({
  records: z.array(opsOrderSchema).default([]),
  total: pageNumber,
  page: pageNumber,
  size: pageNumber,
}).passthrough();

export const opsAfterSalesPageSchema = z.object({
  records: z.array(opsAfterSalesSchema).default([]),
  total: pageNumber,
  page: pageNumber,
  size: pageNumber,
}).passthrough();

export const merchantBackendSessionSchema = z
  .object({
    cookie: z.string().optional(),
    cookieSnapshot: z.string().optional(),
    ua: z.string().optional(),
  })
  .passthrough();

export const merchantBackendPrepareSchema = z
  .object({
    action: z.string(),
    message: z.string().optional(),
    sesId: z.string().optional(),
    loginStatus: z.union([z.string(), z.number()]).optional(),
    clientLoginStatus: z.union([z.string(), z.number()]).optional(),
    session: merchantBackendSessionSchema.optional(),
  })
  .passthrough();

export const refreshSessionSchema = z.object({ accessToken: z.string().min(20) }).passthrough();

export type QrLogin = z.infer<typeof qrLoginSchema>;
export type QrLoginPoll = z.infer<typeof qrLoginPollSchema>;
export type VisibleShopPage = z.infer<typeof visibleShopPageSchema>;
export type SalesLive = z.infer<typeof salesLiveSchema>;
export type OpsOrder = z.infer<typeof opsOrderSchema>;
export type OpsAfterSales = z.infer<typeof opsAfterSalesSchema>;
export type OpsOrderPage = z.infer<typeof opsOrderPageSchema>;
export type OpsAfterSalesPage = z.infer<typeof opsAfterSalesPageSchema>;
export type MerchantBackendPrepare = z.infer<typeof merchantBackendPrepareSchema>;
