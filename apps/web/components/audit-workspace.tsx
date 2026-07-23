"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, Search, X } from "lucide-react";
import { StatusBadge } from "./status-badge";
import { Tooltip } from "./tooltip";

export interface AuditEvent {
  id: string;
  createdAt: string;
  user: string;
  channel: string;
  action: string;
  resource: string | null;
  result: string;
  durationMs: number | null;
  traceId: string;
  tool: string | null;
  params: unknown;
}

export interface AuditFilters {
  search: string;
  channel: string;
  result: string;
  user: string;
  tool: string;
  shop: string;
  start: string;
  end: string;
}

export function AuditWorkspace({ events, filters }: { events: AuditEvent[]; filters: AuditFilters }) {
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <div className="page">
      <div className="page-header">
        <div><h1 className="page-title">审计日志</h1><p className="page-description">查询配置变更和工具调用，使用 Trace ID 追踪</p></div>
      </div>
      <form className="toolbar audit-filters" role="search" aria-label="筛选审计日志">
        <label className="audit-search">
          <span className="sr-only">搜索动作、资源或 Trace ID</span>
          <Search aria-hidden="true" size={16} />
          <input name="search" defaultValue={filters.search} placeholder="搜索动作、资源或 Trace ID" />
        </label>
        <FilterField label="用户"><input name="user" defaultValue={filters.user} placeholder="用户名称" /></FilterField>
        <FilterField label="工具"><input name="tool" defaultValue={filters.tool} placeholder="工具名称" /></FilterField>
        <FilterField label="店铺"><input name="shop" defaultValue={filters.shop} placeholder="店铺名称或 ID" /></FilterField>
        <FilterField label="渠道">
          <select name="channel" defaultValue={filters.channel} className="filter-select">
            <option value="">全部渠道</option><option value="WEB">Web</option><option value="OPENCLAW">OpenClaw</option><option value="WORKER">Worker</option>
          </select>
        </FilterField>
        <FilterField label="结果">
          <select name="result" defaultValue={filters.result} className="filter-select">
            <option value="">全部结果</option><option value="SUCCEEDED">成功</option><option value="PARTIAL">部分成功</option><option value="FAILED">失败</option>
          </select>
        </FilterField>
        <FilterField label="开始日期"><input name="start" type="date" defaultValue={filters.start} /></FilterField>
        <FilterField label="结束日期"><input name="end" type="date" defaultValue={filters.end} /></FilterField>
        <button className="button" type="submit">查询</button>
        {Object.values(filters).some(Boolean) ? <a className="button" href="/settings/audit">清除筛选</a> : null}
      </form>

      <div className="data-table-wrap" role="region" tabIndex={0} aria-label="审计日志表格，可横向滚动">
        <table className="data-table audit-desktop-table">
          <caption className="sr-only">审计日志，共 {events.length} 条记录</caption>
          <thead><tr><th>时间</th><th>用户</th><th>渠道</th><th>动作</th><th>店铺/资源</th><th>工具</th><th>结果</th><th>耗时</th><th>Trace ID</th><th><span className="sr-only">操作</span></th></tr></thead>
          <tbody>{events.map((event) => (
            <tr key={event.id}>
              <td className="tabular">{formatDateTime(event.createdAt)}</td><td>{event.user}</td><td>{event.channel}</td><td>{event.action}</td><td>{event.resource ?? "暂无"}</td><td>{event.tool ?? "暂无"}</td><td><StatusBadge status={event.result} /></td><td className="muted">{formatDuration(event.durationMs)}</td><td><code>{shortTrace(event.traceId)}</code></td>
              <td><Tooltip label="查看审计详情" side="left"><button className="icon-button" type="button" aria-label={`查看 ${event.action} 详情`} onClick={(click) => { triggerRef.current = click.currentTarget; setSelected(event); }}><Eye size={16} /></button></Tooltip></td>
            </tr>
          ))}</tbody>
        </table>
        <div className="audit-mobile-list" aria-label={`审计日志，共 ${events.length} 条记录`}>
          {events.map((event) => (
            <article className="audit-mobile-row" key={event.id}>
              <header><div><strong>{event.action}</strong><span>{formatDateTime(event.createdAt)}</span></div><StatusBadge status={event.result} /></header>
              <dl>
                <div><dt>用户</dt><dd>{event.user}</dd></div><div><dt>渠道</dt><dd>{event.channel}</dd></div><div><dt>资源</dt><dd>{event.resource ?? "暂无"}</dd></div><div><dt>工具</dt><dd>{event.tool ?? "暂无"}</dd></div><div><dt>耗时</dt><dd>{formatDuration(event.durationMs)}</dd></div><div className="audit-trace"><dt>Trace ID</dt><dd><code>{event.traceId}</code></dd></div>
              </dl>
              <button className="button audit-detail-button" type="button" onClick={(click) => { triggerRef.current = click.currentTarget; setSelected(event); }}><Eye size={16} />查看详情</button>
            </article>
          ))}
        </div>
        {events.length === 0 ? <div className="table-empty">没有符合条件的审计记录。</div> : null}
      </div>

      {selected ? <AuditDrawer event={selected} onClose={() => {
        setSelected(null);
        window.setTimeout(() => triggerRef.current?.focus(), 0);
      }} /> : null}
    </div>
  );
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="audit-filter-field"><span>{label}</span>{children}</label>;
}

function AuditDrawer({ event, onClose }: { event: AuditEvent; onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const handleKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") {
        keyboardEvent.preventDefault();
        onClose();
        return;
      }
      if (keyboardEvent.key !== "Tab" || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')];
      if (!controls.length) return;
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (keyboardEvent.shiftKey && document.activeElement === first) {
        keyboardEvent.preventDefault(); last.focus();
      } else if (!keyboardEvent.shiftKey && document.activeElement === last) {
        keyboardEvent.preventDefault(); first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onMouseDown={(mouseEvent) => {
      if (mouseEvent.target === mouseEvent.currentTarget) onClose();
    }}>
      <aside ref={dialogRef} className="report-drawer audit-drawer" role="dialog" aria-modal="true" aria-labelledby="audit-detail-title">
        <div className="drawer-header">
          <div><h2 id="audit-detail-title">审计详情</h2><p>{event.action}</p></div>
          <Tooltip label="关闭审计详情" side="left"><button ref={closeRef} className="icon-button" type="button" aria-label="关闭审计详情" onClick={onClose}><X size={18} /></button></Tooltip>
        </div>
        <div className="drawer-body">
          <dl className="audit-detail-meta">
            <div><dt>时间</dt><dd>{formatDateTime(event.createdAt)}</dd></div><div><dt>用户</dt><dd>{event.user}</dd></div><div><dt>渠道</dt><dd>{event.channel}</dd></div><div><dt>结果</dt><dd><StatusBadge status={event.result} /></dd></div><div><dt>资源</dt><dd>{event.resource ?? "暂无"}</dd></div><div><dt>工具</dt><dd>{event.tool ?? "暂无"}</dd></div><div><dt>耗时</dt><dd>{formatDuration(event.durationMs)}</dd></div><div><dt>Trace ID</dt><dd><code>{event.traceId}</code></dd></div>
          </dl>
          <section className="audit-params"><h3>脱敏参数</h3><pre>{safeJson(event.params)}</pre></section>
        </div>
      </aside>
    </div>
  );
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function formatDuration(value: number | null) {
  return value === null ? "暂无" : value >= 1_000 ? `${(value / 1_000).toFixed(2)}s` : `${value}ms`;
}
function shortTrace(value: string) {
  return value.length > 16 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}
function safeJson(value: unknown) {
  try { return JSON.stringify(value ?? null, null, 2); } catch { return "无法显示"; }
}
