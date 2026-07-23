"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Copy, FileBarChart, MessageCircle } from "lucide-react";
import { StatusBadge } from "./status-badge";

export interface ReportDetail {
  id: string;
  type: "DAILY" | "WEEKLY";
  periodStart: string;
  periodEnd: string;
  version: number;
  shopCount: number;
  deliveryStatus: string;
  dataAsOf: string;
  createdAt: string;
  data: {
    summary: { salesAmount: number | null; transactionCount: number | null; payBuyerCount: number | null; refundAmount: number | null; averageOrderValue: number | null };
    shops: Array<{ shopId: string; shopName: string; salesAmount: number | null; transactionCount: number | null; payBuyerCount: number | null; refundAmount: number | null; averageOrderValue: number | null; freshness: string; dataAsOf: string | null; missing: boolean }>;
    freshness: string;
    dataAsOf: string | null;
    partial: boolean;
    missingShops: string[];
  };
  deliveries?: Array<{ id?: string; channel: string; recipient: string; status: string; attempts: number; errorCode: string | null; lastAttemptAt: string | null; sentAt: string | null }>;
  previews: { wechat: string };
}

export function ReportDetailView({ report }: { report: ReportDetail }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const title = report.type === "DAILY" ? "经营日报" : "经营周报";
  const period = report.periodStart === report.periodEnd ? report.periodStart : `${report.periodStart} 至 ${report.periodEnd}`;
  const wechatDeliveries = (report.deliveries ?? []).filter((delivery) => delivery.channel === "WECHAT");

  useEffect(() => {
    if (report.deliveryStatus !== "PENDING") return;
    const timer = window.setInterval(() => router.refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [report.deliveryStatus, router]);

  async function copyPreview() {
    await navigator.clipboard.writeText(report.previews.wechat);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }

  return <div className="page report-detail-page">
    <div className="report-detail-back"><Link href="/reports"><ArrowLeft size={17} />返回报表</Link></div>
    <div className="page-header">
      <div><div className="report-detail-title"><h1 className="page-title">{title}</h1><StatusBadge status="快照" /></div><p className="page-description">{period} · v{report.version}，内容固定为生成时的数据</p></div>
      <button className="button" onClick={() => void copyPreview()}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? "已复制" : "复制微信版"}</button>
    </div>

    <div className="report-detail-meta">
      <Meta label="数据状态"><StatusBadge status={report.data.freshness} /></Meta>
      <Meta label="店铺范围"><strong>{report.shopCount} 家店铺</strong></Meta>
      <Meta label="数据截止"><strong>{report.data.dataAsOf ? dateTime(report.data.dataAsOf) : "暂无可用数据"}</strong></Meta>
      <Meta label="生成时间"><strong>{dateTime(report.createdAt)}</strong></Meta>
      <Meta label="微信推送"><StatusBadge status={deliveryLabel(report.deliveryStatus)} /></Meta>
    </div>

    {report.data.partial ? <div className="banner" role="status">本快照包含缺失数据{report.data.missingShops.length ? `：${report.data.missingShops.join("、")}` : ""}</div> : null}

    <div className="kpi-grid report-detail-kpis">
      <Metric label="销售额" value={money(report.data.summary.salesAmount)} />
      <Metric label="订单量" value={count(report.data.summary.transactionCount)} />
      <Metric label="付款人数" value={count(report.data.summary.payBuyerCount)} />
      <Metric label="客单价" value={money(report.data.summary.averageOrderValue)} />
      <Metric label="退款金额" value={money(report.data.summary.refundAmount)} />
    </div>

    <div className="two-column report-detail-grid">
      <section className="panel">
        <div className="panel-header"><div><div className="panel-title">店铺排名</div><div className="panel-subtitle">按快照销售额从高到低</div></div><FileBarChart size={18} /></div>
        <div className="data-table-wrap report-ranking-wrap"><table className="data-table report-ranking-desktop"><thead><tr><th>排名</th><th>店铺</th><th>销售额</th><th>订单量</th><th>客单价</th><th>退款金额</th><th>数据状态</th></tr></thead><tbody>{report.data.shops.map((shop, index) => <tr key={shop.shopId}><td>{index + 1}</td><td><Link className="table-link" href={`/shops/${encodeURIComponent(shop.shopId)}`}>{shop.shopName}</Link></td><td className="number-cell">{money(shop.salesAmount)}</td><td className="number-cell">{count(shop.transactionCount)}</td><td className="number-cell">{money(shop.averageOrderValue)}</td><td className="number-cell">{money(shop.refundAmount)}</td><td><StatusBadge status={shop.missing ? "UNKNOWN" : shop.freshness} /></td></tr>)}</tbody></table><div className="report-ranking-mobile">{report.data.shops.map((shop, index) => <article key={shop.shopId}><div><span className="ranking-index">{index + 1}</span><Link className="table-link" href={`/shops/${encodeURIComponent(shop.shopId)}`}>{shop.shopName}</Link></div><StatusBadge status={shop.missing ? "UNKNOWN" : shop.freshness} /><dl><div><dt>销售额</dt><dd>{money(shop.salesAmount)}</dd></div><div><dt>订单量</dt><dd>{count(shop.transactionCount)}</dd></div><div><dt>客单价</dt><dd>{money(shop.averageOrderValue)}</dd></div><div><dt>退款金额</dt><dd>{money(shop.refundAmount)}</dd></div></dl></article>)}</div>{!report.data.shops.length ? <div className="table-empty">暂无店铺数据</div> : null}</div>
      </section>

      <section className="panel report-preview-panel">
        <div className="panel-header"><div><div className="panel-title">微信版预览</div><div className="panel-subtitle">最终私聊文本效果</div></div><MessageCircle size={18} /></div>
        <div className="panel-body"><pre className="wechat-preview">{report.previews.wechat}</pre>{wechatDeliveries.length ? <div className="delivery-history"><div className="delivery-history-title">投递记录</div><div className="delivery-history-list">{wechatDeliveries.map((delivery, index) => <div className="delivery-history-row" key={delivery.id ?? `${delivery.recipient}-${index}`}><div><strong>{delivery.recipient}</strong><small>{delivery.sentAt ? `发送于 ${dateTime(delivery.sentAt)}` : delivery.lastAttemptAt ? `最近尝试 ${dateTime(delivery.lastAttemptAt)}` : "等待首次发送"}</small></div><StatusBadge status={deliveryRecordLabel(delivery.status)} /></div>)}</div></div> : null}</div>
      </section>
    </div>
  </div>;
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) { return <div><span>{label}</span>{children}</div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="kpi"><div className="kpi-label">{label}</div><div className="kpi-value">{value}</div><div className="kpi-change">快照口径</div></div>; }
function money(value: number | null) { return value === null ? "--" : new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format(value); }
function count(value: number | null) { return value === null ? "--" : Math.round(value).toLocaleString("zh-CN"); }
function dateTime(value: string) { return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }); }
function deliveryLabel(value: string) { return value === "SENT" ? "已推送" : value === "PENDING" ? "推送中" : value === "FAILED" ? "推送失败" : "未推送"; }
function deliveryRecordLabel(value: string) { return value === "SUCCEEDED" ? "已推送" : value === "QUEUED" || value === "SENDING" ? "推送中" : value === "FAILED" ? "推送失败" : value; }
