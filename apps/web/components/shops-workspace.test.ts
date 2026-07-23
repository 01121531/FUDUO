import { describe, expect, it } from "vitest";
import {
  buildShopsCsv,
  filterShops,
  nextShopSort,
  paginateShops,
  shopSortState,
  sortShops,
  type ShopRow,
} from "./shops-utils";

const shops: ShopRow[] = [
  { id: 101, accountId: 1001, name: "晴川百货", platform: "pdd", loginStatus: "正常", todaySales: 1200, todayOrders: 12, refundAmount: 20, lastSyncedAt: new Date().toISOString() },
  { id: 202, accountId: 2002, name: "远山家居", platform: "pdd", loginStatus: "失效", todaySales: null, todayOrders: null, refundAmount: null, lastSyncedAt: null },
];

describe("shop workspace helpers", () => {
  it("searches names and IDs and combines status filters", () => {
    expect(filterShops(shops, { query: "1001", loginFilter: "ALL", dataFilter: "ALL" }).map((shop) => shop.id)).toEqual([101]);
    expect(filterShops(shops, { query: "", loginFilter: "失效", dataFilter: "UNKNOWN" }).map((shop) => shop.id)).toEqual([202]);
    expect(filterShops(shops, { query: "远山", loginFilter: "正常", dataFilter: "ALL" })).toEqual([]);
  });

  it("exports the visible rows and protects spreadsheet formula cells", () => {
    const csv = buildShopsCsv([{ ...shops[0]!, name: "=HYPERLINK(\"bad\")" }]);
    expect(csv).toContain("shopId");
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toContain("\r\n\"=HYPERLINK");
  });

  it("sorts nullable metrics consistently without mutating source rows", () => {
    const source = [shops[1]!, { ...shops[0]!, id: 303, name: "白云店", todaySales: 1200 }, shops[0]!];
    const snapshot = [...source];
    expect(sortShops(source, "SALES_DESC").map((shop) => shop.name)).toEqual(["白云店", "晴川百货", "远山家居"]);
    expect(sortShops(source, "SALES_ASC").map((shop) => shop.name)).toEqual(["白云店", "晴川百货", "远山家居"]);
    expect(source).toEqual(snapshot);
  });

  it("sorts every table column in both directions and keeps missing values last", () => {
    const source: ShopRow[] = [
      { ...shops[0]!, id: 1, name: "甲店", todaySales: 100, todayOrders: 10, refundAmount: 5, lastSyncedAt: "2026-07-22T10:00:00.000Z" },
      { ...shops[0]!, id: 2, name: "乙店", todaySales: 200, todayOrders: 20, refundAmount: 10, lastSyncedAt: "2026-07-23T10:00:00.000Z" },
      { ...shops[0]!, id: 3, name: "丙店", todaySales: null, todayOrders: null, refundAmount: null, lastSyncedAt: null },
    ];

    expect(sortShops(source, "NAME_ASC").map((shop) => shop.id)).toEqual([3, 1, 2]);
    expect(sortShops(source, "NAME_DESC").map((shop) => shop.id)).toEqual([2, 1, 3]);
    expect(sortShops(source, "SALES_ASC").map((shop) => shop.id)).toEqual([1, 2, 3]);
    expect(sortShops(source, "SALES_DESC").map((shop) => shop.id)).toEqual([2, 1, 3]);
    expect(sortShops(source, "ORDERS_ASC").map((shop) => shop.id)).toEqual([1, 2, 3]);
    expect(sortShops(source, "ORDERS_DESC").map((shop) => shop.id)).toEqual([2, 1, 3]);
    expect(sortShops(source, "REFUNDS_ASC").map((shop) => shop.id)).toEqual([1, 2, 3]);
    expect(sortShops(source, "REFUNDS_DESC").map((shop) => shop.id)).toEqual([2, 1, 3]);
    expect(sortShops(source, "SYNCED_ASC").map((shop) => shop.id)).toEqual([1, 2, 3]);
    expect(sortShops(source, "SYNCED_DESC").map((shop) => shop.id)).toEqual([2, 1, 3]);
  });

  it("uses column defaults and toggles active table header sorting", () => {
    expect(nextShopSort("SALES_DESC", "NAME")).toBe("NAME_ASC");
    expect(nextShopSort("NAME_ASC", "NAME")).toBe("NAME_DESC");
    expect(nextShopSort("NAME_DESC", "SALES")).toBe("SALES_DESC");
    expect(nextShopSort("SALES_DESC", "SALES")).toBe("SALES_ASC");
    expect(shopSortState("SYNCED_DESC")).toEqual({ column: "SYNCED", direction: "DESC" });
  });

  it("paginates twenty-one matching shops as twenty plus one", () => {
    const rows = Array.from({ length: 21 }, (_, index) => ({ ...shops[0]!, id: index + 1 }));
    expect(paginateShops(rows, 1, 20)).toHaveLength(20);
    expect(paginateShops(rows, 2, 20)).toHaveLength(1);
  });
});
