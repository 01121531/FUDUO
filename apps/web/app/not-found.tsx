import Link from "next/link";
import { ArrowLeft, FileQuestion } from "lucide-react";

export default function NotFound() {
  return <main className="login-page">
    <section className="login-form empty-state">
      <FileQuestion size={32} />
      <h1 className="page-title">页面不存在</h1>
      <p className="page-description">链接可能已失效，或当前账号没有对应入口。</p>
      <Link className="button primary" href="/dashboard"><ArrowLeft size={17} />返回销售总览</Link>
    </section>
  </main>;
}
