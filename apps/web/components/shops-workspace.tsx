"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Download, LoaderCircle, RefreshCw, Search } from "lucide-react";
import Link from "next/link";
import { ShopTable, type ShopRow } from "./shop-table";
import { buildShopsCsv, filterShops, paginateShops, sortShops, type DataFilter, type ShopSort } from "./shops-utils";
import { Tooltip } from "./tooltip";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
const PAGE_SIZE = 20;
type LoginFilter = "ALL" | string;

interface ShopsWorkspaceProps {
  initialShops: ShopRow[];
  canSync: boolean;
  initialQuery?: string;
  initialLoginFilter?: string;
  initialDataFilter?: DataFilter;
  initialSort?: ShopSort;
  initialPage?: number;
}

export function ShopsWorkspace({ initialShops, canSync, initialQuery = "", initialLoginFilter = "ALL", initialDataFilter = "ALL", initialSort = "SALES_DESC", initialPage = 1 }: ShopsWorkspaceProps) {
  const [query, setQuery] = useState(initialQuery);
  const [loginFilter, setLoginFilter] = useState<LoginFilter>(initialLoginFilter);
  const [dataFilter, setDataFilter] = useState<DataFilter>(initialDataFilter);
  const [sort, setSort] = useState<ShopSort>(initialSort);
  const [page, setPage] = useState(initialPage);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "danger"; text: string } | null>(null);

  const loginStatuses = useMemo(() => [...new Set(initialShops.map((shop) => shop.loginStatus).filter((value): value is string => Boolean(value)))].sort(), [initialShops]);
  const matchingShops = useMemo(() => sortShops(filterShops(initialShops, { query, loginFilter, dataFilter }), sort), [dataFilter, initialShops, loginFilter, query, sort]);
  const pageCount = Math.max(1, Math.ceil(matchingShops.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageShops = useMemo(() => paginateShops(matchingShops, currentPage, PAGE_SIZE), [currentPage, matchingShops]);

  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setOrDelete(params, "q", query.trim());
    setOrDelete(params, "login", loginFilter === "ALL" ? "" : loginFilter);
    setOrDelete(params, "data", dataFilter === "ALL" ? "" : dataFilter);
    setOrDelete(params, "sort", sort === "SALES_DESC" ? "" : sort);
    setOrDelete(params, "page", currentPage === 1 ? "" : String(currentPage));
    const next = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
    window.history.replaceState(window.history.state, "", next);
  }, [currentPage, dataFilter, loginFilter, query, sort]);

  async function syncVisible() {
    if (!matchingShops.length || syncing) return;
    setSyncing(true);
    setNotice(null);
    try {
      const response = await fetch(`${API_URL}/sync/runs`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "sales-live-sync", shopIds: matchingShops.map((shop) => String(shop.id)) }),
      });
      const body = await response.json() as { success: boolean; error?: { message?: string } };
      if (!response.ok || !body.success) throw new Error(body.error?.message ?? "同步任务提交失败");
      setNotice({ kind: "success", text: `已提交 ${matchingShops.length} 家店铺的销售同步任务` });
    } catch (error) {
      setNotice({ kind: "danger", text: error instanceof Error ? error.message : "同步任务提交失败" });
    } finally {
      setSyncing(false);
    }
  }

  function clearFilters() {
    setQuery("");
    setLoginFilter("ALL");
    setDataFilter("ALL");
    setPage(1);
  }

  function exportVisible() {
    const csv = buildShopsCsv(matchingShops);
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `富多店铺-${businessDate()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div><h1 className="page-title">店铺</h1><p className="page-description">共 {initialShops.length} 家店铺，当前显示 {matchingShops.length} 家</p></div>
        <div className="toolbar shops-actions">
          <button className="button" disabled={!matchingShops.length} onClick={exportVisible}><Download size={17} />导出当前结果</button>
          {canSync ? <button className="button primary" disabled={!matchingShops.length || syncing} onClick={() => void syncVisible()}>
            {syncing ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}同步当前结果
          </button> : null}
        </div>
      </div>
      {notice ? <div className={`inline-notice ${notice.kind}`} role={notice.kind === "danger" ? "alert" : "status"}>{notice.text}</div> : null}
      <div className="toolbar shops-filters">
        <label className="shop-search">
          <span className="sr-only">搜索店铺</span><Search size={16} aria-hidden="true" />
          <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜索店铺名称、shopId 或 accountId" />
        </label>
        <label><span className="sr-only">登录状态</span><select className="filter-select" value={loginFilter} onChange={(event) => { setLoginFilter(event.target.value); setPage(1); }}><option value="ALL">全部登录状态</option>{loginStatuses.map((status) => <option value={status} key={status}>{status}</option>)}</select></label>
        <label><span className="sr-only">数据状态</span><select className="filter-select" value={dataFilter} onChange={(event) => { setDataFilter(event.target.value as DataFilter); setPage(1); }}><option value="ALL">全部数据状态</option><option value="LIVE">实时</option><option value="RECENT">最近同步</option><option value="STALE">已过期</option><option value="UNKNOWN">从未同步</option></select></label>
        <label><span className="sr-only">排序</span><select className="filter-select" value={sort} onChange={(event) => { setSort(event.target.value as ShopSort); setPage(1); }}><option value="SALES_DESC">销售额从高到低</option><option value="SALES_ASC">销售额从低到高</option><option value="ORDERS_DESC">订单量从高到低</option><option value="ORDERS_ASC">订单量从低到高</option><option value="REFUNDS_DESC">退款金额从高到低</option><option value="REFUNDS_ASC">退款金额从低到高</option><option value="NAME_ASC">店铺名称升序</option><option value="NAME_DESC">店铺名称降序</option><option value="SYNCED_DESC">最近同步从新到旧</option><option value="SYNCED_ASC">最近同步从旧到新</option></select></label>
      </div>
      {matchingShops.length > 0
        ? <ShopTable shops={pageShops} sort={sort} onSortChange={(nextSort) => { setSort(nextSort); setPage(1); }} />
        : initialShops.length > 0
          ? <div className="shops-empty" role="status">
            <strong>没有符合当前筛选条件的店铺</strong>
            <p>调整搜索词或筛选条件后再试。</p>
            <button className="button" type="button" onClick={clearFilters}>清除筛选</button>
          </div>
          : <div className="shops-empty" role="status">
            <strong>还没有可用店铺</strong>
            <p>完成富多授权后，店铺会自动同步到这里。</p>
            <Link className="button primary" href="/settings/erp">前往富多授权</Link>
          </div>}
      {matchingShops.length ? <nav className="shops-pagination" aria-label="店铺分页">
        <span>第 {currentPage} / {pageCount} 页，共 {matchingShops.length} 家</span>
      <div><Tooltip label="上一页"><button className="button icon-button" type="button" aria-label="上一页" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={17} /></button></Tooltip><Tooltip label="下一页"><button className="button icon-button" type="button" aria-label="下一页" disabled={currentPage >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}><ChevronRight size={17} /></button></Tooltip></div>
      </nav> : null}
    </div>
  );
}

function businessDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function setOrDelete(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}
