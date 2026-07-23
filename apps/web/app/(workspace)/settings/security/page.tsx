import { TotpSecurity } from "@/components/totp-security";

export default function SecurityPage() {
  return <div className="page"><div className="page-header"><div><h1 className="page-title">账号安全</h1><p className="page-description">管理二次验证和登录会话</p></div></div><TotpSecurity /></div>;
}
