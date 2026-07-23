import { ReportsPanel } from "@/components/reports-panel";
import { apiGet } from "@/lib/api";

export default async function ReportsPage() {
  const [user, shops] = await Promise.all([
    apiGet<{ permissions: string[] }>("/auth/me"),
    apiGet<Array<{ id: number; name: string }>>("/shops"),
  ]);
  const canGenerate = user.permissions.includes("*") || user.permissions.includes("reports:generate");
  const canManageSchedules = user.permissions.includes("*") || user.permissions.includes("settings:reports");
  return <div className="page"><div className="page-header"><div><h1 className="page-title">报表</h1><p className="page-description">保存不可变经营快照，并按计划推送到微信</p></div></div><ReportsPanel canGenerate={canGenerate} canManageSchedules={canManageSchedules} shopOptions={shops.map((shop) => ({ id: String(shop.id), name: shop.name }))} /></div>;
}
