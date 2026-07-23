"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, LoaderCircle, RefreshCw } from "lucide-react";
import { formatCurrency, type Freshness, type SalesMetric, type Shop } from "@fuduo/shared";
import { Metric } from "./metric";
import { SalesChart, type SalesChartPoint } from "./sales-chart";
import { StatusBadge } from "./status-badge";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
type Tab = "overview" | "sales" | "orders" | "refunds" | "status";
type DataType = "SALES" | "ORDERS" | "REFUNDS";

interface ShopDetail {
  shop: Shop;
  sales: SalesMetric | null;
  trend: SalesChartPoint[];
}

interface DataTypeStatus {
  freshness: Freshness;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  source: string | null;
  partial: boolean;
  errorCode: string | null;
}

export interface ShopHistory {
  shopId: string;
  range: { start: string; end: string; days: number };
  sales: Array<{ date: string; salesAmount: number | null; transactionCount: number | null; payBuyerCount: number | null; averageOrderValue: number | null; refundAmount: number | null; fetchedAt: string }>;
  orders: Array<{ date: string; orderCount: number | null; paidOrderCount: number | null; paidAmount: number | null; fetchedAt: string }>;
  refunds: Array<{ date: string; refundCount: number | null; refundAmount: number | null; fetchedAt: string }>;
  dataStatus: Record<DataType, DataTypeStatus>;
}

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "sales", label: "销售" },
  { id: "orders", label: "订单" },
  { id: "refunds", label: "退款" },
  { id: "status", label: "数据状态" },
];

export function ShopDetailWorkspace({ detail, history, canSync }: { detail: ShopDetail; history: ShopHistory; canSync: boolean }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [syncing, setSyncing] = useState(false);
  const [tabsReady, setTabsReady] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "danger"; text: string } | null>(null);
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const { shop } = detail;
  const latestSync = latestDate(Object.values(history.dataStatus ?? {}).map((item) => item.lastSuccessAt));

  useEffect(() => setTabsReady(true), []);

  async function syncShop() {
    setSyncing(true);
    setNotice(null);
    try {
      const response = await fetch(`${API_URL}/sync/runs`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "sales-live-sync", shopIds: [String(shop.id)] }),
      });
      const body = await response.json() as { success: boolean; error?: { message?: string } };
      if (!response.ok || !body.success) throw new Error(body.error?.message ?? "同步任务提交失败。");
      setNotice({ kind: "success", text: "当前店铺的销售同步任务已提交。" });
    } catch (error) {
      setNotice({ kind: "danger", text: error instanceof Error ? error.message : "同步任务提交失败。" });
    } finally {
      setSyncing(false);
    }
  }

  function selectTab(next: Tab, focus = false) {
    setTab(next);
    if (focus) window.requestAnimationFrame(() => tabRefs.current.get(next)?.focus());
  }

  function handleTabKey(event: KeyboardEvent<HTMLButtonElement>, current: Tab) {
    const index = tabs.findIndex((item) => item.id === current);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectTab(tabs[nextIndex]!.id, true);
  }

  return (
    <div className="page">
      <Link href="/shops" className="table-link detail-back"><ArrowLeft size={16} />返回店铺</Link>
      <div className="page-header">
        <div>
          <h1 className="page-title">{shop.name}</h1>
          <div className="toolbar-group detail-meta">
            <span className="muted">{platformName(shop.platform)} · shopId {shop.id}</span>
            <StatusBadge status={shop.loginStatus ?? "UNKNOWN"} />
            <span className="muted">最近同步 {latestSync ? dateTime(latestSync) : "从未同步"}</span>
          </div>
        </div>
        {canSync ? (
          <button className="button primary" disabled={syncing} onClick={() => void syncShop()}>
            {syncing ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}立即同步
          </button>
        ) : null}
      </div>
      {notice ? <div className={`inline-notice ${notice.kind}`} role={notice.kind === "danger" ? "alert" : "status"}>{notice.text}</div> : null}

      <div
        className="segmented detail-tabs"
        role="tablist"
        aria-label="店铺数据视图"
        data-tabs-ready={tabsReady ? "true" : "false"}
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            id={`shop-tab-${item.id}`}
            ref={(node) => {
              if (node) tabRefs.current.set(item.id, node);
              else tabRefs.current.delete(item.id);
            }}
            type="button"
            role="tab"
            tabIndex={tab === item.id ? 0 : -1}
            aria-selected={tab === item.id}
            aria-controls={`shop-panel-${item.id}`}
            className={`segment ${tab === item.id ? "active" : ""}`}
            onClick={() => selectTab(item.id)}
            onKeyDown={(event) => handleTabKey(event, item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div id={`shop-panel-${tab}`} role="tabpanel" tabIndex={0} aria-labelledby={`shop-tab-${tab}`}>
        {tab === "overview" ? <Overview detail={detail} history={history} /> : null}
        {tab === "sales" ? <SalesRows rows={history.sales} /> : null}
        {tab === "orders" ? <OrderRows rows={history.orders} /> : null}
        {tab === "refunds" ? <RefundRows rows={history.refunds} /> : null}
        {tab === "status" ? <DataStatus detail={detail} history={history} /> : null}
      </div>
    </div>
  );
}

function Overview({ detail: { shop, sales }, history }: { detail: ShopDetail; history: ShopHistory }) {
  const averageOrderValue = sales?.averageOrderValue ?? (shop.todaySales && shop.todayOrders ? shop.todaySales / shop.todayOrders : null);
  const salesTrend = trend(history.sales, (row) => row.salesAmount);
  return (
    <>
      <div className="kpi-grid detail-kpis">
        <Metric label="今日销售额" value={formatCurrency(sales?.salesAmount ?? shop.todaySales)} change={sales ? `数据日期 ${sales.tradeDate}` : "暂无当日明细"} />
        <Metric label="今日订单量" value={(sales?.transactionCount ?? shop.todayOrders)?.toLocaleString("zh-CN") ?? "暂无"} change={sales ? `付款人数 ${sales.payBuyerCount ?? "暂无"}` : "暂无当日明细"} />
        <Metric label="客单价" value={formatCurrency(averageOrderValue)} change="按当前销售额与订单量计算" />
        <Metric label="退款金额" value={formatCurrency(sales?.refundAmount ?? shop.refundAmount)} change="只读经营数据" />
      </div>
      <section className="panel">
        <div className="panel-header">
          <div><div className="panel-title">销售趋势</div><div className="muted panel-subtitle">最近 30 个业务日</div></div>
          <StatusBadge status={history.dataStatus?.SALES?.freshness ?? sales?.freshness ?? "UNKNOWN"} />
        </div>
        <div className="panel-body">
          <SalesChart
            data={salesTrend}
            label={`${shop.name}最近 30 天销售趋势`}
            dataAsOf={history.dataStatus?.SALES?.lastSuccessAt}
          />
        </div>
      </section>
    </>
  );
}

function SalesRows({ rows }: { rows: ShopHistory["sales"] }) {
  return (
    <DailySection title="近 30 天销售" subtitle="销售额趋势与业务日明细">
      <div className="detail-chart">
        <SalesChart data={trend(rows, (row) => row.salesAmount)} label="近 30 天销售额趋势" dataAsOf={latestFetched(rows)} />
      </div>
      <table className="data-table detail-desktop-table">
        <thead><tr><th>日期</th><th className="number">销售额</th><th className="number">订单量</th><th className="number">付款人数</th><th className="number">客单价</th><th className="number">退款金额</th><th>采集时间</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.date}><td>{row.date}</td><td className="number">{formatCurrency(row.salesAmount)}</td><td className="number">{number(row.transactionCount)}</td><td className="number">{number(row.payBuyerCount)}</td><td className="number">{formatCurrency(row.averageOrderValue)}</td><td className="number">{formatCurrency(row.refundAmount)}</td><td className="muted">{dateTime(row.fetchedAt)}</td></tr>)}</tbody>
      </table>
      <div className="detail-mobile-list">{rows.map((row) => <DailyMobile key={row.date} date={row.date} primary={formatCurrency(row.salesAmount)} fields={[`订单 ${number(row.transactionCount)}`, `退款 ${formatCurrency(row.refundAmount)}`]} />)}</div>
      {!rows.length ? <EmptyRows text="暂无销售日汇总数据。" /> : null}
    </DailySection>
  );
}

function OrderRows({ rows }: { rows: ShopHistory["orders"] }) {
  return (
    <DailySection title="近 30 天订单" subtitle="订单量趋势与业务日明细">
      <div className="detail-chart">
        <SalesChart
          data={trend(rows, (row) => row.orderCount)}
          label="近 30 天订单量趋势"
          currentName="订单量"
          previousName="对比订单量"
          dataAsOf={latestFetched(rows)}
          valueKind="number"
        />
      </div>
      <table className="data-table detail-desktop-table">
        <thead><tr><th>日期</th><th className="number">订单量</th><th className="number">支付订单</th><th className="number">支付金额</th><th>采集时间</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.date}><td>{row.date}</td><td className="number">{number(row.orderCount)}</td><td className="number">{number(row.paidOrderCount)}</td><td className="number">{formatCurrency(row.paidAmount)}</td><td className="muted">{dateTime(row.fetchedAt)}</td></tr>)}</tbody>
      </table>
      <div className="detail-mobile-list">{rows.map((row) => <DailyMobile key={row.date} date={row.date} primary={`${number(row.orderCount)} 单`} fields={[`支付 ${number(row.paidOrderCount)}`, formatCurrency(row.paidAmount)]} />)}</div>
      {!rows.length ? <EmptyRows text="暂无订单日汇总数据。" /> : null}
    </DailySection>
  );
}

function RefundRows({ rows }: { rows: ShopHistory["refunds"] }) {
  return (
    <DailySection title="近 30 天退款" subtitle="退款金额趋势与业务日明细">
      <div className="detail-chart">
        <SalesChart
          data={trend(rows, (row) => row.refundAmount)}
          label="近 30 天退款金额趋势"
          currentName="退款金额"
          previousName="对比退款金额"
          dataAsOf={latestFetched(rows)}
        />
      </div>
      <table className="data-table detail-desktop-table">
        <thead><tr><th>日期</th><th className="number">退款笔数</th><th className="number">退款金额</th><th>采集时间</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.date}><td>{row.date}</td><td className="number">{number(row.refundCount)}</td><td className="number">{formatCurrency(row.refundAmount)}</td><td className="muted">{dateTime(row.fetchedAt)}</td></tr>)}</tbody>
      </table>
      <div className="detail-mobile-list">{rows.map((row) => <DailyMobile key={row.date} date={row.date} primary={formatCurrency(row.refundAmount)} fields={[`退款 ${number(row.refundCount)} 笔`]} />)}</div>
      {!rows.length ? <EmptyRows text="暂无退款日汇总数据。" /> : null}
    </DailySection>
  );
}

function DailySection({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-header"><div><div className="panel-title">{title}</div><div className="panel-subtitle">{subtitle}</div></div></div>
      <div className="data-table-wrap detail-table-wrap">{children}</div>
    </section>
  );
}

function DailyMobile({ date, primary, fields }: { date: string; primary: string; fields: string[] }) {
  return <div className="detail-mobile-row"><span><strong>{date}</strong><small>{fields.join(" · ")}</small></span><strong>{primary}</strong></div>;
}

function EmptyRows({ text }: { text: string }) {
  return <div className="table-empty">{text}</div>;
}

function DataStatus({ detail, history }: { detail: ShopDetail; history: ShopHistory }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <div><div className="panel-title">数据状态</div><div className="panel-subtitle">各类数据的同步结果和恢复线索</div></div>
        <StatusBadge status={detail.shop.loginStatus ?? "UNKNOWN"} />
      </div>
      <div className="data-status-list">
        {(["SALES", "ORDERS", "REFUNDS"] as const).map((type) => {
          const item = history.dataStatus?.[type];
          return (
            <article key={type} className="data-status-row">
              <div><strong>{dataTypeName(type)}</strong><span>{item?.source ?? "暂无来源"}</span></div>
              <StatusBadge status={item?.freshness ?? "UNKNOWN"} />
              <div><span>最后成功</span><strong>{item?.lastSuccessAt ? dateTime(item.lastSuccessAt) : "从未成功"}</strong></div>
              <div><span>最近尝试</span><strong>{item?.lastAttemptAt ? dateTime(item.lastAttemptAt) : "从未尝试"}</strong></div>
              <div><span>错误</span><strong>{item?.errorCode ?? "无"}</strong></div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function trend<T extends { date: string }>(rows: T[], select: (row: T) => number | null): SalesChartPoint[] {
  return [...rows]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((row) => ({ date: row.date, sales: select(row), previous: null }));
}

function latestFetched(rows: Array<{ fetchedAt: string }>) {
  return latestDate(rows.map((row) => row.fetchedAt));
}

function latestDate(values: Array<string | null | undefined>) {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function dataTypeName(type: DataType) {
  return ({ SALES: "销售", ORDERS: "订单", REFUNDS: "退款" })[type];
}

function platformName(platform: string) {
  return platform.toLowerCase() === "pdd" ? "拼多多" : platform;
}

function number(value: number | null) {
  return value?.toLocaleString("zh-CN") ?? "暂无";
}

function dateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}
