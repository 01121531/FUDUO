import { AccountSetup } from "@/components/account-setup";

export default async function AccountSetupPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const { returnTo } = await searchParams;
  return <main className="account-setup-page"><div className="account-setup-shell"><div className="brand-block account-setup-brand"><span className="brand-mark">FD</span><span>富多店铺智能助手</span></div><div><h1 className="page-title">完成账号安全设置</h1><p className="page-description">公司内部账号</p></div><AccountSetup returnTo={returnTo} /></div></main>;
}
