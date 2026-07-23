import type { Metadata } from "next";
import "./globals.css";
import "../styles/visual-refresh.css";

export const metadata: Metadata = {
  title: "富多店铺智能助手",
  description: "公司内部店铺经营数据与 AI 对话工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
