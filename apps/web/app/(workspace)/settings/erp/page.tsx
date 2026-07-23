import { ErpAuthPanel } from "@/components/erp-auth-panel";

export default function ErpSettingsPage() {
  return <div className="page"><div className="page-header"><div><h1 className="page-title">富多授权</h1><p className="page-description">管理云端富多登录、Token 自动刷新和授权状态</p></div></div><ErpAuthPanel /></div>;
}
