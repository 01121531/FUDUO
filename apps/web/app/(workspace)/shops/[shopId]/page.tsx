import { notFound } from "next/navigation";
import type { SalesMetric, Shop } from "@fuduo/shared";
import { ShopDetailWorkspace, type ShopHistory } from "@/components/shop-detail-workspace";
import { apiGet } from "@/lib/api";

export interface ShopDetail {
  shop: Shop;
  sales: SalesMetric | null;
  trend: Array<{ date: string; sales: number | null; previous: number | null }>;
}

async function getDetail(shopId: string): Promise<ShopDetail | null> {
  return apiGet<ShopDetail>(`/shops/${encodeURIComponent(shopId)}`);
}

async function getHistory(shopId: string) {
  return apiGet<ShopHistory>(`/shops/${encodeURIComponent(shopId)}/sales?days=30`);
}

async function getPermissions() {
  return (await apiGet<{ permissions: string[] }>("/auth/me")).permissions;
}

export default async function ShopDetailPage({ params }: { params: Promise<{ shopId: string }> }) {
  const { shopId } = await params;
  if (!/^\d{1,19}$/.test(shopId)) notFound();
  const [detail, history, permissions] = await Promise.all([getDetail(shopId), getHistory(shopId), getPermissions()]);
  if (!detail) notFound();
  return <ShopDetailWorkspace detail={detail} history={history} canSync={permissions.includes("*") || permissions.includes("sync:run")} />;
}
