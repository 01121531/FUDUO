import { describe, expect, it } from "vitest";
import { planChatTurn } from "./chat-planner.js";

const shops = [
  { shopId: "101", shopName: "晴川百货" },
  { shopId: "102", shopName: "云野生活馆" },
  { shopId: "103", shopName: "拾光家居" },
];
const now = new Date("2026-07-22T01:00:00.000Z");

describe("chat planner", () => {
  it("resolves a partial shop name, intent, and Shanghai date range", () => {
    expect(planChatTurn("晴川昨天的订单怎么样", shops, null, now)).toEqual({
      kind: "tool",
      name: "get_shop_orders",
      params: { shopId: "101", startDate: "2026-07-21", endDate: "2026-07-21" },
    });
    expect(planChatTurn("对比晴川和云野近7天销售", shops, null, now)).toEqual({
      kind: "tool",
      name: "compare_shop_sales",
      params: { shopIds: ["101", "102"], startDate: "2026-07-16", endDate: "2026-07-22" },
    });
  });

  it("asks for clarification when a required shop or date range is missing", () => {
    expect(planChatTurn("查询昨天订单", shops, null, now)).toMatchObject({ kind: "clarify" });
    expect(planChatTurn("最近销售如何", shops, null, now)).toMatchObject({ kind: "clarify" });
  });

  it("accepts a schema-valid model plan but rejects unknown shops and arbitrary tools", () => {
    expect(planChatTurn("查销售", shops, '{"name":"get_shop_sales","params":{"shopId":"102"}}', now)).toEqual({ kind: "tool", name: "get_shop_sales", params: { shopId: "102" } });
    expect(planChatTurn("查销售", shops, '{"name":"get_shop_sales","params":{"shopId":"999"}}', now)).toEqual({ kind: "tool", name: "get_sales_summary", params: {} });
    expect(planChatTurn("查销售", shops, '{"name":"http_request","params":{"url":"http://127.0.0.1"}}', now)).toEqual({ kind: "tool", name: "get_sales_summary", params: {} });
  });
});
