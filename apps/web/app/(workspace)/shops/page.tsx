import { ShopsWorkspace } from "@/components/shops-workspace";
import type { ShopRow } from "@/components/shop-table";
import { apiGet } from "@/lib/api";
import type { ShopSort } from "@/components/shops-utils";

async function getShops(): Promise<ShopRow[]> {
  return apiGet<ShopRow[]>("/shops");
}

interface CurrentUser { permissions: string[] }

async function getPermissions() {
  return (await apiGet<CurrentUser>("/auth/me")).permissions;
}

export default async function ShopsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [shops, permissions, params] = await Promise.all([getShops(), getPermissions(), searchParams]);
  const value = (key: string) => typeof params[key] === "string" ? params[key] : "";
  const data = value("data");
  const sort = shopSort(value("sort"));
  const parsedPage = Number.parseInt(value("page"), 10);
  return <ShopsWorkspace
    initialShops={shops}
    canSync={permissions.includes("*") || permissions.includes("sync:run")}
    initialQuery={value("q")}
    initialLoginFilter={value("login") || "ALL"}
    initialDataFilter={data === "LIVE" || data === "RECENT" || data === "STALE" || data === "UNKNOWN" ? data : "ALL"}
    initialSort={sort}
    initialPage={Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1}
  />;
}

function shopSort(value: string): ShopSort {
  const sorts: ShopSort[] = [
    "NAME_ASC",
    "NAME_DESC",
    "SALES_ASC",
    "SALES_DESC",
    "ORDERS_ASC",
    "ORDERS_DESC",
    "REFUNDS_ASC",
    "REFUNDS_DESC",
    "SYNCED_ASC",
    "SYNCED_DESC",
  ];
  return sorts.includes(value as ShopSort) ? value as ShopSort : "SALES_DESC";
}
