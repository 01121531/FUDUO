import { SyncCenter } from "@/components/sync-center";
import { apiGet } from "@/lib/api";

export default async function SyncPage() {
  const user = await apiGet<{ permissions: string[] }>("/auth/me");
  const canSync = user.permissions.includes("*") || user.permissions.includes("sync:run");
  return <div className="page"><div className="page-header"><div><h1 className="page-title">同步中心</h1><p className="page-description">查看店铺数据同步、失败重试和数据新鲜度</p></div></div><SyncCenter canSync={canSync} canManageGlobal={user.permissions.includes("*")} /></div>;
}
