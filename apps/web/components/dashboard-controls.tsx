"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Check, ChevronDown, LoaderCircle, RefreshCw, Search, Store } from "lucide-react";

export type DashboardPeriod = "today" | "yesterday" | "7d" | "30d" | "custom";

interface DashboardShop { id: number; name: string }
interface Props {
  period: DashboardPeriod;
  shops: DashboardShop[];
  selectedShopIds: number[];
  syncTradeDate: string;
  customStart: string;
  customEnd: string;
  canSync: boolean;
}

interface SyncRunResponse {
  id: string;
  status: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { message?: string };
}

const periods: Array<{ value: DashboardPeriod; label: string }> = [
  { value: "today", label: "今天" },
  { value: "yesterday", label: "昨天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
const LIVE_SYNC_TYPES = ["sales-live-sync", "orders-sync", "refunds-sync"] as const;
const TERMINAL_SYNC_STATUSES = new Set(["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"]);

export function DashboardControls({ period, shops, selectedShopIds, syncTradeDate, customStart, customEnd, canSync }: Props) {
  const router = useRouter();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(() => new Set(selectedShopIds));
  const [customOpen, setCustomOpen] = useState(false);
  const [start, setStart] = useState(customStart);
  const [end, setEnd] = useState(customEnd);
  const [customError, setCustomError] = useState<string | null>(null);
  const maxDate = useMemo(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), []);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "danger"; text: string } | null>(null);
  const filteredShops = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return normalized ? shops.filter((shop) => shop.name.toLocaleLowerCase("zh-CN").includes(normalized) || String(shop.id).includes(normalized)) : shops;
  }, [query, shops]);

  useEffect(() => { setSelection(new Set(selectedShopIds)); }, [selectedShopIds]);
  useEffect(() => { setStart(customStart); setEnd(customEnd); }, [customStart, customEnd]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [router]);

  function toggleShop(id: number) {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function applyShops() {
    router.push(dashboardUrl(period, [...selection], customStart, customEnd));
    if (detailsRef.current) detailsRef.current.open = false;
  }

  function applyCustomRange() {
    if (!start || !end) return setCustomError("请选择开始和结束日期");
    if (start > end) return setCustomError("开始日期不能晚于结束日期");
    if (end > maxDate) return setCustomError("结束日期不能晚于今天");
    const days = Math.round((new Date(`${end}T00:00:00.000Z`).getTime() - new Date(`${start}T00:00:00.000Z`).getTime()) / 86_400_000) + 1;
    if (days > 366) return setCustomError("日期范围不能超过 366 天");
    setCustomError(null);
    setCustomOpen(false);
    router.push(dashboardUrl("custom", selectedShopIds, start, end));
  }

  async function sync() {
    setSyncing(true);
    setNotice(null);
    try {
      const runs = await Promise.all(LIVE_SYNC_TYPES.map(async (type) => {
        const response = await fetch(`${API_URL}/sync/runs`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type, tradeDate: syncTradeDate, ...(selectedShopIds.length ? { shopIds: selectedShopIds.map(String) } : {}) }),
        });
        return readApiResponse<SyncRunResponse>(response, "同步任务创建失败");
      }));
      setNotice({
        type: "success",
        text: `${syncTradeDate}${selectedShopIds.length ? ` · ${selectedShopIds.length} 家店铺` : " · 全部店铺"}销售、订单和退款同步任务已创建`,
      });
      const completed = await waitForSyncRuns(runs.map((run) => run.id));
      router.refresh();
      if (!completed) {
        setNotice({ type: "success", text: "同步任务仍在后台执行，页面会自动更新" });
      } else if (completed.some((run) => run.status !== "SUCCEEDED")) {
        setNotice({ type: "danger", text: "同步已结束，但部分数据未成功，请打开同步中心查看" });
      } else {
        setNotice({ type: "success", text: "销售、订单和退款数据已同步到最新状态" });
      }
    } catch (error) {
      setNotice({ type: "danger", text: error instanceof Error ? error.message : "同步任务创建失败" });
    } finally {
      setSyncing(false);
    }
  }

  return <div className="dashboard-actions">
    <div className="toolbar">
      <div className="segmented" aria-label="统计日期">
        {periods.map((item) => <Link key={item.value} href={dashboardUrl(item.value, selectedShopIds)} className={`segment${period === item.value ? " active" : ""}`} aria-current={period === item.value ? "page" : undefined}>{item.label}</Link>)}
        <button className={`segment${period === "custom" ? " active" : ""}`} aria-expanded={customOpen} onClick={() => { if (detailsRef.current) detailsRef.current.open = false; setCustomOpen((open) => !open); }}><CalendarDays size={14} />自定义</button>
      </div>
      {customOpen ? <div className="custom-range-menu">
        <div className="custom-range-fields"><label>开始日期<input type="date" max={maxDate} value={start} onChange={(event) => setStart(event.target.value)} /></label><label>结束日期<input type="date" max={maxDate} value={end} onChange={(event) => setEnd(event.target.value)} /></label></div>
        {customError ? <div className="custom-range-error" role="alert">{customError}</div> : <div className="muted" style={{ fontSize: 12 }}>最多选择 366 个自然日</div>}
        <div className="store-filter-footer"><button className="button" onClick={() => setCustomOpen(false)}>取消</button><button className="button primary" onClick={applyCustomRange}>应用日期</button></div>
      </div> : null}
      <details className="store-filter" ref={detailsRef}>
        <summary className="button" onClick={() => setCustomOpen(false)}><Store size={17} /><span>{selectedShopIds.length ? `已选 ${selectedShopIds.length} 家` : "全部店铺"}</span><ChevronDown size={15} /></summary>
        <div className="store-filter-menu">
          <label className="store-filter-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索店铺名称或 ID" /></label>
          <div className="store-filter-list">
            {filteredShops.map((shop) => <label className="store-filter-option" key={shop.id}>
              <input type="checkbox" checked={selection.has(shop.id)} onChange={() => toggleShop(shop.id)} />
              <span>{shop.name}<small>{shop.id}</small></span>
              {selection.has(shop.id) ? <Check size={16} /> : null}
            </label>)}
            {filteredShops.length === 0 ? <div className="table-empty">没有匹配的店铺</div> : null}
          </div>
          <div className="store-filter-footer"><button className="button" onClick={() => setSelection(new Set())}>全部店铺</button><button className="button primary" onClick={applyShops}>应用筛选</button></div>
        </div>
      </details>
      {canSync ? <button className="button primary" onClick={() => void sync()} disabled={syncing}>{syncing ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}{syncing ? "同步中" : "立即同步"}</button> : null}
    </div>
    <div className="dashboard-action-status" aria-live="polite">{notice ? <span className={notice.type}>{notice.text}</span> : null}</div>
  </div>;
}

async function waitForSyncRuns(ids: string[]) {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    await delay(attempt === 0 ? 800 : 2_000);
    if (document.visibilityState !== "visible") continue;
    const runs = await Promise.all(ids.map(async (id) => {
      const response = await fetch(`${API_URL}/sync/runs/${encodeURIComponent(id)}`, {
        credentials: "include",
        cache: "no-store",
      });
      return readApiResponse<SyncRunResponse>(response, "无法读取同步状态");
    }));
    if (runs.every((run) => TERMINAL_SYNC_STATUSES.has(run.status))) return runs;
  }
  return null;
}

async function readApiResponse<T>(response: Response, fallback: string): Promise<T> {
  const raw = await response.text();
  let body: ApiEnvelope<T> | null = null;
  try {
    body = raw ? JSON.parse(raw) as ApiEnvelope<T> : null;
  } catch {
    throw new Error(response.ok ? `${fallback}：服务返回格式异常` : `${fallback}：服务暂时不可用（HTTP ${response.status}）`);
  }
  if (!response.ok || !body?.success || body.data === undefined) {
    throw new Error(body?.error?.message ?? `${fallback}（HTTP ${response.status}）`);
  }
  return body.data;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function dashboardUrl(period: DashboardPeriod, shopIds: number[], start?: string, end?: string) {
  const query = new URLSearchParams({ period });
  if (shopIds.length) query.set("shops", [...shopIds].sort((a, b) => a - b).join(","));
  if (period === "custom" && start && end) { query.set("start", start); query.set("end", end); }
  return `/dashboard?${query.toString()}`;
}
