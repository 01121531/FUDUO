import { z } from "zod";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const metric = z.number().finite().nullable();
const freshness = z.enum(["LIVE", "RECENT", "STALE", "UNKNOWN"]);
const freshnessMetadata = z.object({
  freshness,
  dataAsOf: z.string().datetime().nullable(),
  lastAttemptAt: z.string().datetime().nullable(),
  source: z.string().nullable(),
  partial: z.boolean(),
  errorCode: z.string().nullable(),
});

export const reportSnapshotDataSchema = z.object({
  period: z.object({ startDate: date, endDate: date }),
  shops: z.array(z.object({
    shopId: z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform(String),
    shopName: z.string().min(1).max(200),
    salesAmount: metric,
    transactionCount: metric,
    payBuyerCount: metric,
    refundAmount: metric,
    averageOrderValue: metric,
    freshness,
    dataAsOf: z.string().datetime().nullable(),
    lastAttemptAt: z.string().datetime().nullable().optional(),
    source: z.string().nullable().optional(),
    freshnessByType: z.object({
      SALES: freshnessMetadata.optional(),
      ORDERS: freshnessMetadata.optional(),
      REFUNDS: freshnessMetadata.optional(),
    }).optional(),
    partial: z.boolean().optional().default(false),
    missing: z.boolean().optional().default(false),
  })).max(100),
  summary: z.object({
    salesAmount: metric,
    transactionCount: metric,
    payBuyerCount: metric,
    refundAmount: metric,
    averageOrderValue: metric,
  }),
  freshness,
  dataAsOf: z.string().datetime().nullable(),
  lastAttemptAt: z.string().datetime().nullable().optional(),
  source: z.string().nullable().optional(),
  partial: z.boolean(),
  missingShops: z.array(z.string().max(200)).max(100).optional().default([]),
}).passthrough();

export type ReportSnapshotData = z.infer<typeof reportSnapshotDataSchema>;

export function parseReportSnapshotData(value: unknown): ReportSnapshotData {
  return reportSnapshotDataSchema.parse(value);
}

export function buildWechatReportPreview(
  type: "DAILY" | "WEEKLY",
  periodStart: string,
  periodEnd: string,
  data: ReportSnapshotData,
): string {
  const lines = [
    `${type === "DAILY" ? "经营日报" : "经营周报"} | ${periodStart === periodEnd ? periodStart : `${periodStart} 至 ${periodEnd}`}`,
    "",
    `销售额：${money(data.summary.salesAmount)}`,
    `订单量：${count(data.summary.transactionCount)}`,
    `付款人数：${count(data.summary.payBuyerCount)}`,
    `客单价：${money(data.summary.averageOrderValue)}`,
    `退款金额：${money(data.summary.refundAmount)}`,
  ];
  if (data.shops.length) {
    lines.push("", "店铺排名：");
    for (const [index, shop] of data.shops.slice(0, 5).entries()) {
      lines.push(`${index + 1}. ${shop.shopName} ${money(shop.salesAmount)}`);
    }
  }
  if (data.missingShops.length) lines.push("", `缺失店铺：${data.missingShops.join("、")}`);
  lines.push(`数据状态：${freshnessLabel(data.freshness)}${data.partial ? "（不完整）" : "（完整）"}`);
  lines.push("", `数据截止：${data.dataAsOf ? dateTime(data.dataAsOf) : "暂无可用数据"}`);
  return lines.join("\n");
}

function freshnessLabel(value: ReportSnapshotData["freshness"]) {
  if (value === "LIVE") return "实时";
  if (value === "RECENT") return "近期";
  if (value === "STALE") return "已过期";
  return "未知";
}

function money(value: number | null) {
  return value === null ? "暂无" : new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(value);
}

function count(value: number | null) {
  return value === null ? "暂无" : Math.round(value).toLocaleString("zh-CN");
}

function dateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}
