import { MembersPanel } from "@/components/members-panel";

export default function MembersPage() {
  return <div className="page"><div className="page-header"><div><h1 className="page-title">员工与权限</h1><p className="page-description">管理员工角色、可见店铺和微信绑定状态</p></div></div><MembersPanel /></div>;
}
