"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CalendarClock, FileBarChart, LoaderCircle, Plus, X } from "lucide-react";
import { StatusBadge } from "./status-badge";
import { Tooltip } from "./tooltip";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
interface Report { id: string; type: string; periodStart: string; periodEnd: string; version: number; dataAsOf: string; createdAt: string; deliveryStatus: string }
interface Schedule { id: string; type: "DAILY" | "WEEKLY"; cron: string; timezone: string; active: boolean; shopIds: string[]; channels: string[]; updatedAt: string }
interface ShopOption { id: string; name: string }

export function ReportsPanel({ canGenerate, canManageSchedules, shopOptions }: { canGenerate: boolean; canManageSchedules: boolean; shopOptions: ShopOption[] }) {
  const [reports, setReports] = useState<Report[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [busy, setBusy] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const scheduleButtonRef = useRef<HTMLButtonElement>(null);
  const hasPendingDelivery = reports.some((report) => report.deliveryStatus === "PENDING");

  useEffect(() => {
    void loadReports().finally(() => setInitialLoading(false));
    if (canManageSchedules) void loadSchedules();
  }, [canManageSchedules]);
  useEffect(() => {
    if (!hasPendingDelivery) return;
    const timer = window.setInterval(() => void loadReports(), 10_000);
    return () => window.clearInterval(timer);
  }, [hasPendingDelivery]);

  async function loadReports() {
    try {
      const response = await fetch(`${API_URL}/reports`, { credentials: "include" });
      const body = await response.json() as { success: boolean; data?: Report[]; error?: { message?: string } };
      if (!response.ok || !body.success) throw new Error(body.error?.message ?? "无法读取报表");
      setReports(body.data ?? []);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "无法读取报表"); }
  }

  async function loadSchedules() {
    try {
      const response = await fetch(`${API_URL}/reports/schedules`, { credentials: "include" });
      const body = await response.json() as { success: boolean; data?: Schedule[]; error?: { message?: string } };
      if (!response.ok || !body.success) throw new Error(body.error?.message ?? "无法读取定时报表");
      setSchedules(body.data ?? []);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "无法读取定时报表"); }
  }

  async function generate(type: "DAILY" | "WEEKLY") {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`${API_URL}/reports/generate`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type }) });
      const body = await response.json() as { success: boolean; error?: { message?: string } };
      if (!response.ok || !body.success) throw new Error(body.error?.message ?? "报表生成失败");
      await loadReports();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "报表生成失败"); }
    finally { setBusy(false); }
  }

  async function toggleSchedule(schedule: Schedule) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`${API_URL}/reports/schedules/${encodeURIComponent(schedule.id)}`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: !schedule.active }) });
      const body = await response.json() as { success: boolean; error?: { message?: string } };
      if (!response.ok || !body.success) throw new Error(body.error?.message ?? "定时报表更新失败");
      await loadSchedules();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "定时报表更新失败"); }
    finally { setBusy(false); }
  }

  if (initialLoading) {
    return <div className="report-loading" role="status"><LoaderCircle className="spin" size={20} />正在加载报表</div>;
  }

  return <>
    <div className="toolbar report-actions">
      {canManageSchedules ? <button ref={scheduleButtonRef} className="button" onClick={() => setDrawerOpen(true)}><CalendarClock size={17} />新建定时报表</button> : null}
      {canGenerate ? <><button className="button" disabled={busy} onClick={() => void generate("WEEKLY")}><FileBarChart size={17} />生成周报</button><button className="button primary" disabled={busy} onClick={() => void generate("DAILY")}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}生成日报</button></> : null}
    </div>
    {error ? <div className="banner" role="alert">{error}</div> : null}
    <section className="section report-section">
      <div className="section-header"><h2 className="section-title">报表快照</h2></div>
      <div className="data-table-wrap"><table className="data-table report-desktop"><thead><tr><th>报表</th><th>类型</th><th>统计范围</th><th>版本</th><th>数据截止</th><th>生成时间</th><th>推送状态</th><th aria-label="操作" /></tr></thead><tbody>{reports.map((report) => <tr key={report.id}><td><Link className="table-link report-name" href={`/reports/${encodeURIComponent(report.id)}`}><FileBarChart size={17} />{report.type === "DAILY" ? "经营日报" : "经营周报"}</Link></td><td><StatusBadge status={report.type === "DAILY" ? "日报" : "周报"} /></td><td>{report.periodStart === report.periodEnd ? report.periodStart : `${report.periodStart} 至 ${report.periodEnd}`}</td><td>v{report.version}</td><td className="muted">{dateTime(report.dataAsOf)}</td><td className="muted">{dateTime(report.createdAt)}</td><td><StatusBadge status={deliveryLabel(report.deliveryStatus)} /></td><td><Link className="button" href={`/reports/${encodeURIComponent(report.id)}`}>查看</Link></td></tr>)}</tbody></table><div className="report-mobile-list">{reports.map((report) => <article className="report-mobile-row" key={report.id}><div className="report-mobile-heading"><Link className="report-name table-link" href={`/reports/${encodeURIComponent(report.id)}`}><FileBarChart size={17} /><strong>{report.type === "DAILY" ? "经营日报" : "经营周报"}</strong></Link><StatusBadge status={report.type === "DAILY" ? "日报" : "周报"} /></div><dl><div><dt>统计范围</dt><dd>{report.periodStart === report.periodEnd ? report.periodStart : `${report.periodStart} 至 ${report.periodEnd}`}</dd></div><div><dt>版本</dt><dd>v{report.version}</dd></div><div><dt>数据截止</dt><dd>{dateTime(report.dataAsOf)}</dd></div><div><dt>生成时间</dt><dd>{dateTime(report.createdAt)}</dd></div><div><dt>推送状态</dt><dd><StatusBadge status={deliveryLabel(report.deliveryStatus)} /></dd></div></dl><Link className="button report-mobile-action" href={`/reports/${encodeURIComponent(report.id)}`}>查看报表</Link></article>)}</div>{reports.length === 0 ? <div className="auth-empty compact-empty"><FileBarChart size={28} /><strong>暂无报表</strong></div> : null}</div>
    </section>
    {canManageSchedules ? <ScheduleList schedules={schedules} busy={busy} onToggle={toggleSchedule} shopOptions={shopOptions} /> : null}
    {drawerOpen ? <ScheduleDrawer shopOptions={shopOptions} onClose={() => { setDrawerOpen(false); window.setTimeout(() => scheduleButtonRef.current?.focus(), 0); }} onCreated={async () => { setDrawerOpen(false); await loadSchedules(); window.setTimeout(() => scheduleButtonRef.current?.focus(), 0); }} /> : null}
  </>;
}

function ScheduleList({ schedules, busy, onToggle, shopOptions }: { schedules: Schedule[]; busy: boolean; onToggle: (schedule: Schedule) => Promise<void>; shopOptions: ShopOption[] }) {
  const names = new Map(shopOptions.map((shop) => [shop.id, shop.name]));
  return <section className="section report-section"><div className="section-header"><h2 className="section-title">定时报表</h2></div><div className="data-table-wrap">
    <table className="data-table schedule-desktop"><thead><tr><th>类型</th><th>执行时间</th><th>店铺范围</th><th>投递渠道</th><th>状态</th><th aria-label="操作" /></tr></thead><tbody>{schedules.map((schedule) => <tr key={schedule.id}><td>{schedule.type === "DAILY" ? "经营日报" : "经营周报"}</td><td>{scheduleLabel(schedule)}</td><td>{scopeLabel(schedule.shopIds, names)}</td><td>{schedule.channels.map(channelLabel).join("、")}</td><td><StatusBadge status={schedule.active ? "正常" : "已停用"} /></td><td><button className="button" disabled={busy} onClick={() => void onToggle(schedule)}>{schedule.active ? "停用" : "启用"}</button></td></tr>)}</tbody></table>
    <div className="schedule-mobile-list">{schedules.map((schedule) => <article className="schedule-mobile-row" key={schedule.id}><div><strong>{schedule.type === "DAILY" ? "经营日报" : "经营周报"}</strong><small>{scheduleLabel(schedule)}</small></div><StatusBadge status={schedule.active ? "正常" : "已停用"} /><p>{scopeLabel(schedule.shopIds, names)} · {schedule.channels.map(channelLabel).join("、")}</p><button className="button" disabled={busy} onClick={() => void onToggle(schedule)}>{schedule.active ? "停用" : "启用"}</button></article>)}</div>
    {!schedules.length ? <div className="table-empty">暂无定时报表</div> : null}
  </div></section>;
}

function ScheduleDrawer({ shopOptions, onClose, onCreated }: { shopOptions: ShopOption[]; onClose: () => void; onCreated: () => Promise<void> }) {
  const [type, setType] = useState<"DAILY" | "WEEKLY">("DAILY");
  const [time, setTime] = useState("08:30");
  const [weekdays, setWeekdays] = useState(["1"]);
  const [scoped, setScoped] = useState(false);
  const [shopIds, setShopIds] = useState<string[]>([]);
  const [channels, setChannels] = useState(["WEB", "WECHAT"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const controls = [...dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.offsetParent !== null);
      if (!controls.length) return;
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (type === "WEEKLY" && !weekdays.length) { setError("每周报表至少选择一天"); return; }
    if (scoped && !shopIds.length) { setError("请选择至少一家店铺"); return; }
    if (!channels.length) { setError("请选择至少一个投递渠道"); return; }
    const [hour, minute] = time.split(":");
    const cron = `0 ${Number(minute)} ${Number(hour)} * * ${type === "DAILY" ? "*" : [...weekdays].sort().join(",")}`;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`${API_URL}/reports/schedules`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, cron, timezone: "Asia/Shanghai", shopIds: scoped ? shopIds : [], channels }) });
      const body = await response.json() as { success: boolean; error?: { message?: string } };
      if (!response.ok || !body.success) throw new Error(body.error?.message ?? "定时报表创建失败");
      await onCreated();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "定时报表创建失败"); }
    finally { setBusy(false); }
  }

  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside ref={dialogRef} className="report-drawer" role="dialog" aria-modal="true" aria-labelledby="schedule-drawer-title" aria-describedby="schedule-drawer-description"><div className="drawer-header"><div><h2 id="schedule-drawer-title">新建定时报表</h2><p id="schedule-drawer-description">计划将在北京时间执行</p></div><Tooltip label="关闭定时报表表单" side="left"><button ref={closeRef} type="button" className="icon-action" aria-label="关闭" onClick={onClose}><X size={19} /></button></Tooltip></div><form className="drawer-body" onSubmit={(event) => void submit(event)}>
    {error ? <div className="inline-notice danger" role="alert">{error}</div> : null}
    <label className="field"><span>报表类型</span><select autoFocus value={type} onChange={(event) => { const next = event.target.value as "DAILY" | "WEEKLY"; setType(next); if (next === "DAILY") setTime("08:30"); else setTime("09:00"); }}><option value="DAILY">经营日报</option><option value="WEEKLY">经营周报</option></select></label>
    <label className="field"><span>执行时间</span><input type="time" required value={time} onChange={(event) => setTime(event.target.value)} /></label>
    {type === "WEEKLY" ? <fieldset className="drawer-fieldset"><legend>执行星期</legend><div className="weekday-options">{[["1","一"],["2","二"],["3","三"],["4","四"],["5","五"],["6","六"],["7","日"]].map(([value, label]) => <label key={value}><input type="checkbox" checked={weekdays.includes(value!)} onChange={() => setWeekdays(toggle(weekdays, value!))} /><span>{label}</span></label>)}</div></fieldset> : null}
    <label className="check-row"><input type="checkbox" checked={scoped} onChange={(event) => setScoped(event.target.checked)} /><span><strong>仅指定店铺</strong><small>未勾选时包含全部可用店铺</small></span></label>
    {scoped ? <fieldset className="drawer-fieldset"><legend>店铺范围</legend><div className="drawer-shop-list">{shopOptions.map((shop) => <label key={shop.id}><input type="checkbox" checked={shopIds.includes(shop.id)} onChange={() => setShopIds(toggle(shopIds, shop.id))} /><span>{shop.name}</span></label>)}</div></fieldset> : null}
    <fieldset className="drawer-fieldset"><legend>投递渠道</legend><div className="channel-options"><label><input type="checkbox" checked={channels.includes("WEB")} onChange={() => setChannels(toggle(channels, "WEB"))} /><span>Web</span></label><label><input type="checkbox" checked={channels.includes("WECHAT")} onChange={() => setChannels(toggle(channels, "WECHAT"))} /><span>微信</span></label></div></fieldset>
    <div className="drawer-actions"><button type="button" className="button" onClick={onClose}>取消</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Plus size={17} />}创建计划</button></div>
  </form></aside></div>;
}

function scheduleLabel(schedule: Schedule) { const parts = schedule.cron.split(" "); const time = `${parts[2]?.padStart(2, "0")}:${parts[1]?.padStart(2, "0")}`; return schedule.type === "DAILY" ? `每天 ${time}` : `每周${(parts[5] ?? "1").split(",").map((day) => "一二三四五六日"[Number(day) - 1]).join("、")} ${time}`; }
function scopeLabel(shopIds: string[], names: Map<string, string>) { if (!shopIds.length) return "全部店铺"; const visible = shopIds.map((id) => names.get(id) ?? `shopId ${id}`); return visible.length <= 2 ? visible.join("、") : `${visible.slice(0, 2).join("、")}等 ${visible.length} 家`; }
function channelLabel(value: string) { return value === "WECHAT" ? "微信" : value === "WEB" ? "Web" : value; }
function deliveryLabel(value: string) { return value === "SENT" ? "已推送" : value === "PENDING" ? "推送中" : value === "FAILED" ? "推送失败" : "未推送"; }
function toggle(values: string[], value: string) { return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]; }
function dateTime(value: string) { return new Date(value).toLocaleString("zh-CN", { hour12: false }); }
