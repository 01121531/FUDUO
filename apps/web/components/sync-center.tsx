"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarDays,
  ChevronRight,
  CircleCheck,
  Clock3,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Store,
  X,
} from "lucide-react";
import { StatusBadge } from "./status-badge";
import { Tooltip } from "./tooltip";
import { formatDuration, groupRunItems, isRetryable, latestSuccessfulRun, type Run } from "./sync-center-model";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
const TERMINAL_FAILURES = new Set(["FAILED", "PARTIAL"]);
const ACTIVE_RUN_STATUSES = new Set(["QUEUED", "RUNNING", "RETRY_WAIT"]);

interface QueueStatus {
  connected: boolean;
  queueLength: number;
  active: number;
  failed: number;
}

interface ShopOption { id: number | string; name: string }

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: { message?: string };
}

export function SyncCenter({ canSync, canManageGlobal }: { canSync: boolean; canManageGlobal: boolean }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [queueStatus, setQueueStatus] = useState<QueueStatus>({ connected: false, queueLength: 0, active: 0, failed: 0 });
  const [shops, setShops] = useState<ShopOption[]>([]);
  const [syncType, setSyncType] = useState("sales-live-sync");
  const [recordType, setRecordType] = useState("ALL");
  const [recordShop, setRecordShop] = useState("ALL");
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawerError, setDrawerError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const selectedRunId = useRef<string | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const hasActiveRun = runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = window.setInterval(() => void load(), 1_000);
    return () => window.clearInterval(timer);
  }, [hasActiveRun]);

  useEffect(() => {
    if (!selectedRun) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") closeDetail(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selectedRun?.id]);

  async function load() {
    const sequence = ++loadSequence.current;
    const detailId = selectedRunId.current;
    try {
      const [runsResponse, statusResponse, shopsResponse, detailResponse] = await Promise.all([
        fetch(`${API_URL}/sync/runs`, { credentials: "include" }),
        fetch(`${API_URL}/sync/status`, { credentials: "include" }),
        fetch(`${API_URL}/shops`, { credentials: "include" }),
        detailId ? fetch(`${API_URL}/sync/runs/${encodeURIComponent(detailId)}`, { credentials: "include" }) : Promise.resolve(null),
      ]);
      const runsBody = await runsResponse.json() as ApiEnvelope<Run[]>;
      if (!runsResponse.ok || !runsBody.success || !runsBody.data) throw new Error(messageOf(runsBody, "无法读取同步状态"));
      if (sequence !== loadSequence.current) return;
      setRuns(runsBody.data);
      if (detailResponse && detailId && selectedRunId.current === detailId) {
        const detailBody = await detailResponse.json() as ApiEnvelope<Run>;
        if (detailResponse.ok && detailBody.success && detailBody.data) setSelectedRun(detailBody.data);
      } else {
        setSelectedRun((current) => {
          const summary = current ? runsBody.data?.find((run) => run.id === current.id) : undefined;
          if (!current || !summary) return current;
          return current.items ? { ...current, ...summary, items: current.items } : { ...current, ...summary };
        });
      }

      const statusBody = await statusResponse.json() as ApiEnvelope<QueueStatus>;
      setQueueStatus(statusResponse.ok && statusBody.data
        ? statusBody.data
        : { connected: false, queueLength: 0, active: 0, failed: 0 });

      const shopsBody = await shopsResponse.json() as ApiEnvelope<ShopOption[]>;
      if (shopsResponse.ok && shopsBody.data) setShops(shopsBody.data);
      setError(null);
    } catch (caught) {
      if (sequence !== loadSequence.current) return;
      setError(caught instanceof Error ? caught.message : "无法读取同步状态");
    } finally {
      if (sequence === loadSequence.current) setInitialLoading(false);
    }
  }

  async function enqueue(type: string) {
    setBusyAction("enqueue");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`${API_URL}/sync/runs`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const body = await response.json() as ApiEnvelope<{ id: string }>;
      if (!response.ok || !body.success) throw new Error(messageOf(body, "任务创建失败"));
      setNotice("同步任务已加入队列");
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "任务创建失败");
    } finally {
      setBusyAction(null);
    }
  }

  async function openDetail(id: string, preserveFocus = false) {
    if (!preserveFocus && document.activeElement instanceof HTMLElement) restoreFocus.current = document.activeElement;
    setDetailBusy(true);
    setError(null);
    setDrawerError(null);
    try {
      const response = await fetch(`${API_URL}/sync/runs/${encodeURIComponent(id)}`, { credentials: "include" });
      const body = await response.json() as ApiEnvelope<Run>;
      if (!response.ok || !body.success || !body.data) throw new Error(messageOf(body, "无法读取任务详情"));
      selectedRunId.current = id;
      setSelectedRun(body.data);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法读取任务详情");
    } finally {
      setDetailBusy(false);
    }
  }

  async function retry(run: Run) {
    setBusyAction(`retry:${run.id}`);
    setError(null);
    setDrawerError(null);
    setNotice(null);
    try {
      const response = await fetch(`${API_URL}/sync/runs/${encodeURIComponent(run.id)}/retry`, {
        method: "POST",
        credentials: "include",
      });
      const body = await response.json() as ApiEnvelope<{ id: string }>;
      if (!response.ok || !body.success || !body.data) throw new Error(messageOf(body, "重试任务创建失败"));
      setNotice("已按原业务日期和店铺范围创建重试任务");
      await load();
      await openDetail(body.data.id, true);
    } catch (caught) {
      setDrawerError(caught instanceof Error ? caught.message : "重试任务创建失败");
    } finally {
      setBusyAction(null);
    }
  }

  function closeDetail() {
    selectedRunId.current = null;
    setSelectedRun(null);
    setDrawerError(null);
    const target = restoreFocus.current;
    restoreFocus.current = null;
    window.setTimeout(() => target?.focus(), 0);
  }

  const visibleRuns = useMemo(() => runs.filter((run) => {
    if (recordType !== "ALL" && run.type !== recordType) return false;
    if (recordShop === "ALL") return true;
    return run.scopeAllShops || !run.payload.shopIds?.length || run.payload.shopIds.includes(recordShop);
  }), [recordShop, recordType, runs]);
  const lastSuccess = latestSuccessfulRun(runs);
  const failures = runs.filter((run) => TERMINAL_FAILURES.has(run.status)).length;
  const latestFailure = runs.find((run) => TERMINAL_FAILURES.has(run.status));

  if (initialLoading) return <div className="security-loading"><LoaderCircle className="spin" size={20} />正在加载同步状态</div>;

  return <>
    {canSync ? <div className="toolbar sync-actions">
      {canManageGlobal ? <button className="button" disabled={busyAction !== null} onClick={() => void enqueue("shop-catalog-sync")}><RotateCcw size={17} />同步店铺</button> : null}
      <select className="filter-select" aria-label="同步数据类型" value={syncType} disabled={busyAction !== null} onChange={(event) => setSyncType(event.target.value)}>
        <option value="sales-live-sync">销售数据</option>
        <option value="orders-sync">订单数据</option>
        <option value="refunds-sync">退款数据</option>
        <option value="sales-reconcile">近 7 天经营校正</option>
      </select>
      <button className="button primary" disabled={busyAction !== null} onClick={() => void enqueue(syncType)}>
        {busyAction === "enqueue" ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}立即同步
      </button>
      {latestFailure ? <button className="button" disabled={detailBusy} onClick={() => void openDetail(latestFailure.id)}><AlertTriangle size={17} />重试失败任务</button> : null}
    </div> : null}

    {error ? <div className="banner" role="alert"><AlertTriangle size={17} />{error}</div> : null}
    {notice ? <div className="inline-notice success" role="status">{notice}</div> : null}

    <div className="kpi-grid sync-kpi-grid">
      <div className="kpi"><div className="kpi-label">服务状态</div><div style={{ marginTop: 14 }}><StatusBadge status={queueStatus.connected ? "正常" : "FAILED"} /></div><div className="kpi-change">{queueStatus.connected ? "队列服务已连接" : "队列服务不可用"}</div></div>
      <div className="kpi"><div className="kpi-label">队列长度</div><div className="kpi-value">{queueStatus.queueLength}</div><div className="kpi-change">另有 {queueStatus.active} 个任务执行中</div></div>
      <div className="kpi"><div className="kpi-label">最后成功</div><div className="kpi-value sync-last-success">{lastSuccess ? formatTime(lastSuccess.finishedAt!) : "—"}</div><div className="kpi-change">{lastSuccess ? syncTypeLabel(lastSuccess.type) : "暂无记录"}</div></div>
      <div className="kpi"><div className="kpi-label">失败任务数</div><div className="kpi-value">{failures}</div><div className="kpi-change negative">不含等待自动重试</div></div>
    </div>

    <section className="section">
      <div className="section-header sync-record-header">
        <h2 className="section-title">最近同步</h2>
        <div className="toolbar sync-record-filters">
          <select className="filter-select" aria-label="按记录类型筛选" value={recordType} onChange={(event) => setRecordType(event.target.value)}>
            <option value="ALL">全部类型</option>
            <option value="shop-catalog-sync">店铺目录</option>
            <option value="sales-live-sync">销售数据</option>
            <option value="orders-sync">订单数据</option>
            <option value="refunds-sync">退款数据</option>
            <option value="sales-reconcile">近 7 天经营校正</option>
            <option value="credential-refresh">授权刷新</option>
          </select>
          <select className="filter-select" aria-label="按店铺筛选" value={recordShop} onChange={(event) => setRecordShop(event.target.value)}>
            <option value="ALL">全部店铺</option>
            {shops.map((shop) => <option key={shop.id} value={String(shop.id)}>{shop.name}</option>)}
          </select>
        </div>
      </div>
      <div className="data-table-wrap">
        <table className="data-table sync-desktop-table">
          <thead><tr><th>任务 ID</th><th>类型</th><th>业务日期</th><th>状态</th><th className="number">成功/总数</th><th className="number">失败</th><th>开始时间</th><th>耗时</th><th><span className="sr-only">操作</span></th></tr></thead>
          <tbody>{visibleRuns.map((run) => <tr key={run.id}>
            <td className="tabular">{run.id.slice(0, 8)}</td>
            <td>{syncTypeLabel(run.type)}</td>
            <td className="muted">{runDateLabel(run)}</td>
            <td><StatusBadge status={run.status} /></td>
            <td className="number">{run.success}/{run.total}</td>
            <td className="number">{run.failed}</td>
            <td className="muted">{formatDateTime(run.startedAt)}</td>
            <td className="muted">{formatDuration(run.durationMs)}</td>
          <td><Tooltip label="查看同步详情" side="left"><button className="icon-button" aria-label={`查看 ${run.id.slice(0, 8)} 同步详情`} disabled={detailBusy} onClick={() => void openDetail(run.id)}><ChevronRight size={17} /></button></Tooltip></td>
          </tr>)}</tbody>
        </table>
        <div className="sync-mobile-list">{visibleRuns.map((run) => <article className="sync-mobile-row" key={run.id}>
          <div><strong>{syncTypeLabel(run.type)}</strong><span className="muted">{runDateLabel(run)} · {formatDateTime(run.startedAt)}</span></div>
          <StatusBadge status={run.status} />
          <dl><div><dt>任务</dt><dd>{run.id.slice(0, 8)}</dd></div><div><dt>成功</dt><dd>{run.success}/{run.total}</dd></div><div><dt>失败</dt><dd>{run.failed}</dd></div></dl>
          <button className="button sync-mobile-detail" disabled={detailBusy} onClick={() => void openDetail(run.id)}>查看详情<ChevronRight size={16} /></button>
        </article>)}</div>
        {visibleRuns.length === 0 ? <div className="auth-empty compact-empty"><RefreshCw size={28} /><strong>{runs.length ? "没有符合筛选条件的记录" : "暂无同步记录"}</strong>{runs.length ? <button className="button" onClick={() => { setRecordType("ALL"); setRecordShop("ALL"); }}>清除筛选</button> : null}</div> : null}
      </div>
    </section>

    {selectedRun ? <SyncRunDrawer
      run={selectedRun}
      shops={shops}
      canRetry={canSync && isRetryable(selectedRun)}
      retrying={busyAction === `retry:${selectedRun.id}`}
      actionError={drawerError}
      onClose={closeDetail}
      onRetry={() => void retry(selectedRun)}
    /> : null}
  </>;
}

function SyncRunDrawer({ run, shops, canRetry, retrying, actionError, onClose, onRetry }: {
  run: Run;
  shops: ShopOption[];
  canRetry: boolean;
  retrying: boolean;
  actionError: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const shopNames = new Map(shops.map((shop) => [String(shop.id), shop.name]));
  const dates = run.payload.tradeDates ?? (run.payload.tradeDate ? [run.payload.tradeDate] : []);
  const itemGroups = groupRunItems(run.items ?? []);
  const recovery = recoveryFor(run);
  useEffect(() => {
    closeRef.current?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select, input, textarea, details > summary')]
        .filter((element) => element.offsetParent !== null);
      if (!controls.length) return;
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", trapFocus);
    return () => window.removeEventListener("keydown", trapFocus);
  }, []);
  return <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside ref={dialogRef} className="report-drawer sync-drawer" role="dialog" aria-modal="true" aria-labelledby="sync-detail-title">
      <div className="drawer-header">
        <div><h2 id="sync-detail-title">{syncTypeLabel(run.type)}</h2><p className="tabular">任务 {run.id.slice(0, 8)}</p></div>
        <Tooltip label="关闭同步详情" side="left"><button ref={closeRef} className="icon-button" aria-label="关闭同步详情" onClick={onClose}><X size={18} /></button></Tooltip>
      </div>
      <div className="drawer-body">
        <div className="sync-detail-summary">
          <div><span>状态</span><StatusBadge status={run.status} /></div>
          <div><span>成功</span><strong>{run.success}/{run.total}</strong></div>
          <div><span>失败</span><strong>{run.failed}</strong></div>
          <div><span>耗时</span><strong>{formatDuration(run.durationMs)}</strong></div>
        </div>

        <section className="sync-detail-section">
          <h3>阶段时间线</h3>
          <ol className="sync-timeline">
            <li className="complete"><CircleCheck size={16} /><div><strong>已进入队列</strong><span>{formatDateTime(run.createdAt)}</span></div></li>
            <li className={run.status === "QUEUED" ? "pending" : "complete"}>{run.status === "QUEUED" ? <Clock3 size={16} /> : <CircleCheck size={16} />}<div><strong>{run.status === "RETRY_WAIT" ? "本次尝试已结束" : "开始执行"}</strong><span>{run.status === "QUEUED" ? "等待 Worker" : formatDateTime(run.startedAt)}</span></div></li>
            <li className={run.finishedAt ? (run.status === "SUCCEEDED" ? "complete" : "failed") : "pending"}>{run.finishedAt && run.status === "SUCCEEDED" ? <CircleCheck size={16} /> : run.finishedAt ? <AlertTriangle size={16} /> : <Clock3 size={16} />}<div><strong>{run.finishedAt ? statusCompletionLabel(run.status) : run.status === "RETRY_WAIT" ? "等待下一次尝试" : "等待完成"}</strong><span>{run.finishedAt ? formatDateTime(run.finishedAt) : "—"}</span></div></li>
          </ol>
        </section>

        {run.errorCode || run.errorMessage ? <section className="sync-error-panel">
          <AlertTriangle size={18} />
          <div><strong>{run.errorMessage ?? "同步任务未全部成功"}</strong><p>{recovery}</p></div>
        </section> : null}
        {actionError ? <div className="inline-notice danger" role="alert">{actionError}</div> : null}

        {itemGroups.length ? <section className="sync-detail-section">
          <h3>逐店同步结果</h3>
          <div className="sync-item-groups">{itemGroups.map((group) => <article className="sync-item-group" key={group.tradeDate}>
            <header><strong>{group.tradeDate}</strong><span>{group.summaries.reduce((total, summary) => total + summary.total, 0)} 项</span></header>
            <div className="sync-item-summary">{group.summaries.map((summary) => <div key={summary.dataType}>
              <strong>{syncDataTypeLabel(summary.dataType)}</strong>
              <span>{summary.success} 成功 · {summary.failed} 失败</span>
            </div>)}</div>
            {group.failures.length ? <ul className="sync-item-failures">{group.failures.map((item) => <li key={item.id}>
              <div><strong>{item.shopName}</strong><span>{syncDataTypeLabel(item.dataType)} · 第 {item.attempt} 次尝试</span></div>
              <code>{item.errorCode ?? "SYNC_UNKNOWN"}</code>
            </li>)}</ul> : null}
          </article>)}</div>
        </section> : null}

        <section className="sync-detail-section">
          <h3>同步范围</h3>
          <div className="sync-scope-row"><CalendarDays size={17} /><div><strong>{dates.length ? dates.length === 1 ? dates[0] : `${dates.length} 个业务日期` : "不限定业务日期"}</strong>{dates.length > 1 ? <div className="sync-date-list">{dates.map((date) => <span key={date}>{date}<small>销售 · 订单 · 退款</small></span>)}</div> : null}</div></div>
          <div className="sync-scope-row"><Store size={17} /><div><strong>{run.scopeAllShops ? "全部店铺" : `${run.payload.shopIds?.length ?? 0} 家店铺`}</strong>{run.payload.shopIds?.length ? <p>{run.payload.shopIds.map((id) => shopNames.get(id) ?? `店铺 ${id}`).join("、")}</p> : null}</div></div>
        </section>

        <details className="sync-technical">
          <summary>技术详情</summary>
          <dl>
            <div><dt>内部任务类型</dt><dd>{run.type}</dd></div>
            <div><dt>完整任务 ID</dt><dd>{run.id}</dd></div>
            {run.errorCode ? <div><dt>错误代码</dt><dd>{run.errorCode}</dd></div> : null}
            {run.payload.sourceRunId ? <div><dt>来源任务</dt><dd>{run.payload.sourceRunId}</dd></div> : null}
          </dl>
        </details>

        <div className="drawer-actions">
          {run.errorCode === "ERP_REAUTH_REQUIRED" || run.errorCode === "ERP_TOKEN_MISSING"
            ? <a className="button primary" href="/settings/erp">重新授权</a>
            : canRetry ? <button className="button primary" disabled={retrying} onClick={onRetry}>{retrying ? <LoaderCircle className="spin" size={17} /> : <RotateCcw size={17} />}按原范围重试</button>
              : null}
          <button className="button" onClick={onClose}>关闭</button>
        </div>
      </div>
    </aside>
  </div>;
}

function recoveryFor(run: Run) {
  if (run.errorCode === "ERP_REAUTH_REQUIRED" || run.errorCode === "ERP_TOKEN_MISSING") return "富多授权已失效，重新扫码后同步会自动恢复。";
  if (run.errorCode === "SYNC_QUEUE_UNAVAILABLE") return "队列服务暂不可用，请检查 Redis 与 Worker 状态后重新提交。";
  if (run.status === "RETRY_WAIT") return "系统会自动进行下一次尝试，无需手动重复提交。";
  if (!isRetryable(run) && TERMINAL_FAILURES.has(run.status)) return "此历史任务缺少完整运行上下文，请重新创建同步任务。";
  return "可按原业务日期和店铺范围重新执行，已成功数据会通过幂等写入保持一致。";
}

function messageOf(body: ApiEnvelope<unknown>, fallback: string) {
  return body.error?.message ?? body.message ?? fallback;
}

function runDateLabel(run: Run) {
  if (run.payload.tradeDate) return run.payload.tradeDate;
  if (run.payload.tradeDates?.length) return `${run.payload.tradeDates.at(-1)} 至 ${run.payload.tradeDates[0]}`;
  return "—";
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function statusCompletionLabel(status: string) {
  if (status === "SUCCEEDED") return "同步成功";
  if (status === "PARTIAL") return "部分成功";
  if (status === "FAILED") return "同步失败";
  return "任务结束";
}

function syncTypeLabel(type: string) {
  return ({
    "shop-catalog-sync": "店铺目录",
    "sales-live-sync": "销售数据",
    "orders-sync": "订单数据",
    "refunds-sync": "退款数据",
    "sales-reconcile": "近 7 天经营校正",
    "credential-refresh": "授权刷新",
    "report-generate": "报表生成",
    "report-data-refresh": "报表数据补同步",
    "channel-delivery": "报表推送",
  } as Record<string, string>)[type] ?? type;
}

function syncDataTypeLabel(type: string) {
  return ({ sales: "销售", orders: "订单", refunds: "退款" } as Record<string, string>)[type] ?? type;
}
