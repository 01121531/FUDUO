import { calculateFreshness, type Freshness } from "@fuduo/shared";

export interface ShopRow {
  id: number;
  accountId: number | null;
  name: string;
  platform: string;
  loginStatus: string | null;
  todaySales: number | null;
  todayOrders: number | null;
  refundAmount: number | null;
  lastSyncedAt: string | null;
}

export type DataFilter = "ALL" | Freshness;
export type ShopSort =
  | "NAME_ASC"
  | "NAME_DESC"
  | "SALES_ASC"
  | "SALES_DESC"
  | "ORDERS_ASC"
  | "ORDERS_DESC"
  | "REFUNDS_ASC"
  | "REFUNDS_DESC"
  | "SYNCED_ASC"
  | "SYNCED_DESC";
export type ShopSortColumn = "NAME" | "SALES" | "ORDERS" | "REFUNDS" | "SYNCED";
export type ShopSortDirection = "ASC" | "DESC";

export function filterShops(shops: ShopRow[], filters: { query: string; loginFilter: string; dataFilter: DataFilter }) {
  const normalized = filters.query.trim().toLocaleLowerCase("zh-CN");
  return shops.filter((shop) => {
    const matchesQuery = !normalized || [shop.name, String(shop.id), String(shop.accountId ?? "")].some((value) => value.toLocaleLowerCase("zh-CN").includes(normalized));
    const matchesLogin = filters.loginFilter === "ALL" || (shop.loginStatus ?? "未知") === filters.loginFilter;
    const matchesData = filters.dataFilter === "ALL" || freshnessOf(shop) === filters.dataFilter;
    return matchesQuery && matchesLogin && matchesData;
  });
}

export function buildShopsCsv(shops: ShopRow[]) {
  const rows = shops.map((shop) => [shop.name, shop.platform, shop.id, shop.accountId ?? "", shop.loginStatus ?? "未知", shop.todaySales ?? "", shop.todayOrders ?? "", shop.refundAmount ?? "", shop.lastSyncedAt ?? ""]);
  return [["店铺", "平台", "shopId", "accountId", "登录状态", "今日销售额", "订单量", "退款金额", "最近同步"], ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

export function sortShops(shops: ShopRow[], sort: ShopSort): ShopRow[] {
  return [...shops].sort((left, right) => {
    const { column, direction } = shopSortState(sort);
    const nameOrder = compareNames(left, right);
    if (column === "NAME") return direction === "ASC" ? nameOrder : -nameOrder;

    const leftValue = sortValue(left, column);
    const rightValue = sortValue(right, column);
    if (leftValue === null && rightValue === null) return nameOrder;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return leftValue === rightValue ? nameOrder : (leftValue - rightValue) * (direction === "ASC" ? 1 : -1);
  });
}

export function shopSortState(sort: ShopSort): { column: ShopSortColumn; direction: ShopSortDirection } {
  const separator = sort.lastIndexOf("_");
  return {
    column: sort.slice(0, separator) as ShopSortColumn,
    direction: sort.slice(separator + 1) as ShopSortDirection,
  };
}

export function nextShopSort(current: ShopSort, column: ShopSortColumn): ShopSort {
  const state = shopSortState(current);
  const defaultDirection: ShopSortDirection = column === "NAME" ? "ASC" : "DESC";
  const direction = state.column === column
    ? state.direction === "ASC" ? "DESC" : "ASC"
    : defaultDirection;
  return `${column}_${direction}` as ShopSort;
}

export function paginateShops(shops: ShopRow[], page: number, pageSize: number) {
  const safePage = Math.max(1, Math.floor(page));
  return shops.slice((safePage - 1) * pageSize, safePage * pageSize);
}

export function freshnessOf(shop: ShopRow): Freshness {
  return calculateFreshness(shop.lastSyncedAt ? new Date(shop.lastSyncedAt) : null);
}

function csvCell(value: string | number) {
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function compareNames(left: ShopRow, right: ShopRow) {
  return left.name.localeCompare(right.name, "zh-CN") || left.id - right.id;
}

function sortValue(shop: ShopRow, column: Exclude<ShopSortColumn, "NAME">): number | null {
  if (column === "SALES") return shop.todaySales;
  if (column === "ORDERS") return shop.todayOrders;
  if (column === "REFUNDS") return shop.refundAmount;
  if (!shop.lastSyncedAt) return null;
  const timestamp = Date.parse(shop.lastSyncedAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}
