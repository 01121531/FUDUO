import { z } from "zod";
import { parseBusinessToolInput, type BusinessToolName } from "../tools/business-tool.service.js";

const chatToolNames = [
  "list_shops",
  "get_shop_sales",
  "compare_shop_sales",
  "rank_shops_by_sales",
  "get_sales_summary",
  "get_shop_orders",
  "get_shop_refunds",
  "get_data_freshness",
  "get_sync_status",
] as const satisfies readonly BusinessToolName[];

export type ChatToolName = typeof chatToolNames[number];
export interface ShopOption { shopId: string; shopName: string }
export type ChatPlan =
  | { kind: "tool"; name: ChatToolName; params: Record<string, unknown> }
  | { kind: "clarify"; message: string };

const modelPlanSchema = z.object({
  name: z.enum(chatToolNames),
  params: z.record(z.string(), z.unknown()),
}).strict();

export function planChatTurn(message: string, shops: ShopOption[], modelOutput?: string | null, now = new Date()): ChatPlan {
  const fromModel = modelOutput ? parseModelPlan(modelOutput, shops) : null;
  return fromModel ?? deterministicPlan(message, shops, now);
}

function parseModelPlan(raw: string, shops: ShopOption[]): ChatPlan | null {
  const object = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!object) return null;
  try {
    const parsed = modelPlanSchema.parse(JSON.parse(object));
    const params = parseBusinessToolInput(parsed.name, parsed.params);
    if (!shopScopeIsValid(parsed.name, params, shops)) return null;
    return { kind: "tool", name: parsed.name, params };
  } catch {
    return null;
  }
}

function deterministicPlan(message: string, shops: ShopOption[], now: Date): ChatPlan {
  const selected = selectedShops(message, shops);
  const range = dateRange(message, now);
  if (range === null) return { kind: "clarify", message: "请说明具体日期范围，例如今天、昨天、近 7 天或近 30 天。" };

  if (/同步状态|同步记录|任务状态|同步失败/.test(message)) return { kind: "tool", name: "get_sync_status", params: { limit: 10 } };
  if (/新鲜|数据状态|多久没更新|最后更新/.test(message)) return { kind: "tool", name: "get_data_freshness", params: selected.length ? { shopIds: selected } : {} };
  if (/有哪些店|店铺列表|全部店铺|可查看.*店/.test(message) && !/销售|订单|退款|排名|对比|比较/.test(message)) return { kind: "tool", name: "list_shops", params: {} };

  if (/订单/.test(message)) {
    if (selected.length !== 1) return singleShopClarification(selected.length);
    return { kind: "tool", name: "get_shop_orders", params: { shopId: selected[0], ...range } };
  }
  if (/退款|退货/.test(message) && !/销售/.test(message)) {
    if (selected.length !== 1) return singleShopClarification(selected.length);
    return { kind: "tool", name: "get_shop_refunds", params: { shopId: selected[0], ...range } };
  }
  if (/排名|最高|最低|前三|前\s*\d+|top/i.test(message)) {
    const requested = Number(message.match(/(?:前|top\s*)(\d+)/i)?.[1] ?? (/三/.test(message) ? 3 : 10));
    return { kind: "tool", name: "rank_shops_by_sales", params: { limit: Math.min(10, Math.max(1, requested)), ...range } };
  }
  if (/对比|比较|差异/.test(message)) {
    if (selected.length < 2) return { kind: "clarify", message: "请至少指定两家要对比的店铺。" };
    return { kind: "tool", name: "compare_shop_sales", params: { shopIds: selected.slice(0, 10), ...range } };
  }
  if (selected.length === 1) return { kind: "tool", name: "get_shop_sales", params: { shopId: selected[0], ...range } };
  return { kind: "tool", name: "get_sales_summary", params: { ...(selected.length ? { shopIds: selected.slice(0, 10) } : {}), ...range } };
}

function selectedShops(message: string, shops: ShopOption[]) {
  const explicit = new Set(shops.filter((shop) => message.includes(shop.shopId) || nameCandidates(shop.shopName).some((name) => name.length >= 2 && message.includes(name))).map((shop) => shop.shopId));
  return [...explicit];
}

function nameCandidates(value: string) {
  const normalized = value.replace(/\s+/g, "");
  const compact = normalized.replace(/(?:官方)?(?:旗舰店|专营店|专卖店|生活馆|百货|家居|店铺|店)$/u, "");
  return compact === normalized ? [normalized] : [normalized, compact];
}

function dateRange(message: string, now: Date): Record<string, string> | null {
  const today = shanghaiDate(now);
  const dates = [...message.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((match) => match[0]);
  if (dates.length >= 2) return { startDate: dates[0]!, endDate: dates[1]! };
  if (dates.length === 1) return { startDate: dates[0]!, endDate: dates[0]! };
  if (/昨天|昨日/.test(message)) { const day = addDays(today, -1); return { startDate: day, endDate: day }; }
  if (/近\s*7\s*天|最近\s*7\s*天|过去\s*7\s*天|一周/.test(message)) return { startDate: addDays(today, -6), endDate: today };
  if (/近\s*30\s*天|最近\s*30\s*天|过去\s*30\s*天/.test(message)) return { startDate: addDays(today, -29), endDate: today };
  if (/本月|这个月/.test(message)) return { startDate: `${today.slice(0, 8)}01`, endDate: today };
  if (/最近|近期/.test(message)) return null;
  return {};
}

function shopScopeIsValid(name: ChatToolName, params: Record<string, unknown>, shops: ShopOption[]) {
  const allowed = new Set(shops.map((shop) => shop.shopId));
  const ids = name === "get_shop_sales" || name === "get_shop_orders" || name === "get_shop_refunds"
    ? [String(params.shopId ?? "")]
    : Array.isArray(params.shopIds) ? params.shopIds.map(String) : [];
  return ids.every((id) => allowed.has(id));
}

function singleShopClarification(count: number): ChatPlan {
  return { kind: "clarify", message: count > 1 ? "订单或退款查询一次只能查看一家店铺，请指定其中一家。" : "请说明要查询的店铺名称。" };
}

function shanghaiDate(now: Date) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now); }
function addDays(value: string, days: number) { const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
