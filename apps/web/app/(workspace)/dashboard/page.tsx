import { AlertTriangle, Clock3 } from "lucide-react";
import { formatCurrency, type Shop } from "@fuduo/shared";
import { DashboardControls, type DashboardPeriod } from "@/components/dashboard-controls";
import { Metric } from "@/components/metric";
import { SalesChart } from "@/components/sales-chart";
import { StatusBadge } from "@/components/status-badge";
import { apiGet } from "@/lib/api";
import { demoDashboard } from "@/lib/demo";

interface Dashboard {
  period: DashboardPeriod;
  range: { start: string; end: string; previousStart: string; previousEnd: string; dayCount: number; label: string; comparisonLabel: string };
  summary: Omit<typeof demoDashboard.summary, "refundAmount"> & { refundAmount: number | null; refundPartial: boolean };
  changes: { salesAmount: number | null; transactionCount: number | null; payBuyerCount: number | null; averageOrderValue: number | null; refundAmount: number | null };
  rankings: typeof demoDashboard.rankings;
  trend: typeof demoDashboard.trend;
  freshness: "LIVE" | "RECENT" | "STALE" | "UNKNOWN";
  dataAsOf: string;
  alerts: typeof demoDashboard.alerts;
}

interface SyncRun {
  id: string;
  type: string;
  status: string;
  total: number;
  success: number;
  failed: number;
  createdAt: string;
  finishedAt: string | null;
  durationMs: number | null;
}

async function getDashboard(period: DashboardPeriod, shopIds: number[], custom?: { start: string; end: string }): Promise<Dashboard> {
  const query = new URLSearchParams({ period });
  if (shopIds.length) query.set("shopIds", shopIds.join(","));
  if (period === "custom" && custom) {
    query.set("start", custom.start);
    query.set("end", custom.end);
  }
  return apiGet<Dashboard>(`/analytics/dashboard?${query.toString()}`);
}

async function getShops(): Promise<Shop[]> {
  return apiGet<Shop[]>("/shops");
}

async function getPermissions(): Promise<string[]> {
  return (await apiGet<{ permissions: string[] }>("/auth/me")).permissions;
}

async function getSyncRuns(): Promise<SyncRun[]> {
  return apiGet<SyncRun[]>("/sync/runs").catch(() => []);
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string | string[]; shops?: string | string[]; start?: string | string[]; end?: string | string[] }>;
}) {
  const params = await searchParams;
  const period = dashboardPeriod(params.period);
  const custom = period === "custom" ? customRange(params.start, params.end) : undefined;
  const requestedShopIds = parseShopIds(params.shops);
  const [shops, permissions, syncRuns] = await Promise.all([getShops(), getPermissions(), getSyncRuns()]);
  const canSync = permissions.includes("*") || permissions.includes("sync:run");
  const canManageErp = permissions.includes("*") || permissions.includes("settings:erp");
  const availableIds = new Set(shops.map((shop) => shop.id));
  const selectedShopIds = requestedShopIds.filter((id) => availableIds.has(id));
  const data = await getDashboard(period, selectedShopIds, custom);
  const updatedAt = formatDataAsOf(data.dataAsOf);

  if (shops.length === 0) {
    return (
      <div className="page">
        <div className="page-header">
          <div><h1 className="page-title">经营概览</h1><p className="page-description">汇总当前有权限查看的全部拼多多店铺</p></div>
        </div>
        <section className="panel empty-state">
          <h2 className="section-title">暂无可查看的店铺</h2>
          <p className="muted">
            {canManageErp
              ? "完成富多授权并同步店铺后，这里会展示销售、订单和退款概览。"
              : "当前账号尚未分配店铺，请联系管理员配置可查看范围。"}
          </p>
          {canManageErp ? <a className="button primary" href="/settings/erp">前往富多授权</a> : null}
        </section>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">经营概览</h1>
          <p className="page-description">汇总当前有权限查看的全部拼多多店铺</p>
        </div>
        <DashboardControls
          period={period}
          shops={shops.map((shop) => ({ id: shop.id, name: shop.name }))}
          selectedShopIds={selectedShopIds}
          syncTradeDate={data.range.end}
          customStart={data.range.start}
          customEnd={data.range.end}
          canSync={canSync}
        />
      </div>

      <div className="dashboard-data-as-of" role="status">
        <Clock3 size={15} aria-hidden="true" />
        <span>数据截止 {updatedAt}</span>
        <StatusBadge status={data.freshness} />
      </div>

      {data.freshness !== "LIVE" || data.alerts.length ? (
        <div className="banner" role="status">
          <AlertTriangle aria-hidden="true" size={18} style={{ flex: "none", marginTop: 1 }} />
          <div>
            <strong>{data.summary.partial || data.summary.refundPartial ? "所选范围存在缺失数据" : "部分数据不是实时状态"}</strong>
            <div style={{ fontSize: 12 }}>{data.alerts[0]?.detail ?? "请检查同步中心。"}</div>
          </div>
        </div>
      ) : null}

      <div className="kpi-grid">
        <Metric label="销售额" value={formatCurrency(data.summary.salesAmount)} {...changeDisplay(data.changes.salesAmount, data.range.comparisonLabel)} />
        <Metric label="订单量" value={data.summary.transactionCount.toLocaleString("zh-CN")} {...changeDisplay(data.changes.transactionCount, data.range.comparisonLabel)} />
        <Metric label="付款人数" value={data.summary.payBuyerCount.toLocaleString("zh-CN")} {...changeDisplay(data.changes.payBuyerCount, data.range.comparisonLabel)} />
        <Metric label="客单价" value={formatCurrency(data.summary.averageOrderValue)} {...changeDisplay(data.changes.averageOrderValue, data.range.comparisonLabel)} />
        <Metric
          label="退款金额"
          value={formatCurrency(data.summary.refundAmount)}
          {...(data.summary.refundPartial
            ? { change: "统计范围内退款数据不完整", direction: "neutral" as const }
            : changeDisplay(data.changes.refundAmount, data.range.comparisonLabel, true))}
        />
      </div>

      <section className="panel">
        <div className="panel-header">
          <div>
            <div className="panel-title">{data.range.label}销售趋势</div>
            <div className="muted" style={{ fontSize: 12 }}>
              {selectedShopIds.length ? `${selectedShopIds.length} 家店铺` : "全部店铺"}汇总，对比等长上期
            </div>
          </div>
          <StatusBadge status={data.freshness} />
        </div>
        <div className="panel-body">
          <SalesChart data={data.trend} label={`${data.range.label}销售趋势图`} dataAsOf={data.dataAsOf} />
        </div>
      </section>

      <div className="two-column section">
        <section className="panel">
          <div className="panel-header"><span className="panel-title">店铺销售排名</span><a className="table-link" href="/shops">查看全部</a></div>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table dashboard-ranking-table">
              <thead><tr><th>排名</th><th>店铺</th><th className="number">销售额</th><th className="number">订单量</th><th>状态</th></tr></thead>
              <tbody>
                {data.rankings.map((shop, index) => (
                  <tr key={shop.shopId}>
                    <td className="tabular">{index + 1}</td>
                    <td><a className="table-link" href={`/shops/${shop.shopId}`}>{shop.shopName}</a></td>
                    <td className="number">{formatCurrency(shop.salesAmount)}</td>
                    <td className="number">{shop.transactionCount?.toLocaleString("zh-CN") ?? "暂无"}</td>
                    <td><StatusBadge status={shop.freshness} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="dashboard-ranking-mobile">
              {data.rankings.map((shop, index) => (
                <a className="dashboard-ranking-row" href={`/shops/${shop.shopId}`} key={shop.shopId}>
                  <span className="dashboard-rank">{index + 1}</span>
                  <span><strong>{shop.shopName}</strong><small>{shop.transactionCount?.toLocaleString("zh-CN") ?? "暂无"} 笔订单</small></span>
                  <span><strong>{formatCurrency(shop.salesAmount)}</strong><StatusBadge status={shop.freshness} /></span>
                </a>
              ))}
            </div>
            {data.rankings.length === 0 ? <div className="table-empty">所选范围没有店铺数据。</div> : null}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header"><span className="panel-title">需要关注</span><span className="status warning">{data.alerts.length} 项</span></div>
          <div className="panel-body">
            {data.alerts.length === 0 ? (
              <div className="auth-empty compact-empty"><strong>当前没有需要处理的异常</strong></div>
            ) : data.alerts.map((alert) => (
              <div className="alert-row" key={alert.id}>
                <span className={`status ${alert.level === "warning" ? "warning" : "info"}`} style={{ width: 28, height: 28, justifyContent: "center", padding: 0 }}><AlertTriangle size={14} /></span>
                <div><strong>{alert.title}</strong><div className="muted" style={{ marginTop: 3, fontSize: 12 }}>{alert.detail}</div></div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel section">
        <div className="panel-header"><span className="panel-title">最近同步记录</span><a className="table-link" href="/sync">打开同步中心</a></div>
        <div className="recent-sync-list">
          {syncRuns.slice(0, 5).map((run) => (
            <a className="recent-sync-row" href={`/sync?run=${encodeURIComponent(run.id)}`} key={run.id}>
              <span><strong>{syncTypeName(run.type)}</strong><small>{new Date(run.createdAt).toLocaleString("zh-CN", { hour12: false })}</small></span>
              <span>{run.success}/{run.total} 成功{run.failed ? ` · ${run.failed} 失败` : ""}</span>
              <StatusBadge status={run.status} />
            </a>
          ))}
          {syncRuns.length === 0 ? <div className="table-empty">暂无同步记录。</div> : null}
        </div>
      </section>
    </div>
  );
}

function dashboardPeriod(value?: string | string[]): DashboardPeriod {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "yesterday" || raw === "7d" || raw === "30d" || raw === "custom" ? raw : "today";
}

function parseShopIds(value?: string | string[]) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return [];
  return [...new Set(raw.split(",").filter((item) => /^\d+$/.test(item)).map(Number).filter(Number.isSafeInteger))].slice(0, 50);
}

function customRange(startValue?: string | string[], endValue?: string | string[]) {
  const start = Array.isArray(startValue) ? startValue[0] : startValue;
  const end = Array.isArray(endValue) ? endValue[0] : endValue;
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  if (start && end && isBusinessDate(start) && isBusinessDate(end) && start <= end && end <= today) {
    const days = Math.round((new Date(`${end}T00:00:00.000Z`).getTime() - new Date(`${start}T00:00:00.000Z`).getTime()) / 86_400_000) + 1;
    if (days <= 366) return { start, end };
  }
  const first = new Date(`${today}T00:00:00.000Z`);
  first.setUTCDate(first.getUTCDate() - 6);
  return { start: first.toISOString().slice(0, 10), end: today };
}

function isBusinessDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function changeDisplay(value: number | null, label: string, inverse = false): { change: string; direction: "positive" | "negative" | "neutral" } {
  if (value === null) return { change: `${label}：无可比数据`, direction: "neutral" };
  const percent = new Intl.NumberFormat("zh-CN", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: "always",
  }).format(value);
  const effective = inverse ? -value : value;
  return { change: `${label} ${percent}`, direction: effective > 0 ? "positive" : effective < 0 ? "negative" : "neutral" };
}

function formatDataAsOf(value: string) {
  if (!value || value.startsWith("1970-")) return "尚未成功同步";
  return new Date(value).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function syncTypeName(type: string) {
  const labels: Record<string, string> = {
    "shop-catalog-sync": "店铺目录同步",
    "sales-live-sync": "销售实时同步",
    "sales-reconcile": "销售对账补采",
    "orders-sync": "订单同步",
    "refunds-sync": "退款同步",
    "credential-refresh": "凭证刷新",
  };
  return labels[type] ?? type;
}
