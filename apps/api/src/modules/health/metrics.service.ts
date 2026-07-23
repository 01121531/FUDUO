import { Inject, Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service.js";
import { businessDateAsUtc, shanghaiBusinessDate } from "../data/dashboard-period.js";

interface HttpMetric {
  method: string;
  route: string;
  status: string;
  count: number;
  durationSeconds: number;
}

@Injectable()
export class MetricsService {
  private readonly http = new Map<string, HttpMetric>();

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  observeHttp(method: string, route: string, statusCode: number, durationSeconds: number) {
    const safeMethod = /^[A-Z]{3,10}$/.test(method) ? method : "OTHER";
    const safeRoute = normalizeRoute(route);
    const status = String(statusCode);
    const key = `${safeMethod}\u0000${safeRoute}\u0000${status}`;
    const metric = this.http.get(key) ?? { method: safeMethod, route: safeRoute, status, count: 0, durationSeconds: 0 };
    metric.count += 1;
    metric.durationSeconds += Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds : 0);
    this.http.set(key, metric);
  }

  async render() {
    const lines = [
      "# HELP http_requests_total Completed API requests.",
      "# TYPE http_requests_total counter",
      ...[...this.http.values()].flatMap((metric) => [
        `http_requests_total{method="${metric.method}",route="${escapeLabel(metric.route)}",status="${metric.status}"} ${metric.count}`,
      ]),
      "# HELP http_request_duration_seconds API request duration.",
      "# TYPE http_request_duration_seconds summary",
      ...[...this.http.values()].flatMap((metric) => [
        `http_request_duration_seconds_count{method="${metric.method}",route="${escapeLabel(metric.route)}",status="${metric.status}"} ${metric.count}`,
        `http_request_duration_seconds_sum{method="${metric.method}",route="${escapeLabel(metric.route)}",status="${metric.status}"} ${metric.durationSeconds.toFixed(6)}`,
      ]),
      "# HELP metrics_collection_success Whether persistent business metrics were collected successfully.",
      "# TYPE metrics_collection_success gauge",
    ];
    if (!this.database.enabled) return `${lines.concat("metrics_collection_success 1", "demo_mode 1").join("\n")}\n`;
    try {
      lines.push(...await this.databaseMetrics(), "metrics_collection_success 1", "demo_mode 0");
    } catch {
      lines.push("metrics_collection_success 0", "demo_mode 0");
    }
    return `${lines.join("\n")}\n`;
  }

  private async databaseMetrics() {
    const today = businessDateAsUtc(shanghaiBusinessDate());
    const [syncDuration, syncFailures, refreshSucceeded, refreshFailed, toolRuns, agentTurns, modelRuns, channelFailures, shops] = await Promise.all([
      this.database.prisma.$queryRawUnsafe<Array<{ count: bigint | number | string; sumSeconds: number | string }>>(
        'SELECT COUNT(*) AS count, COALESCE(SUM(EXTRACT(EPOCH FROM ("finishedAt" - "startedAt"))), 0)::double precision AS "sumSeconds" FROM "SyncRun" WHERE "startedAt" IS NOT NULL AND "finishedAt" IS NOT NULL',
      ),
      this.database.prisma.syncRun.count({ where: { status: "FAILED" } }),
      this.database.prisma.syncRun.count({ where: { type: "credential-refresh", status: "SUCCEEDED" } }),
      this.database.prisma.syncRun.count({ where: { type: "credential-refresh", status: "FAILED" } }),
      this.database.prisma.toolRun.aggregate({
        where: { name: { not: "__chat_turn__" } },
        _count: { id: true },
        _sum: { durationMs: true },
      }),
      this.database.prisma.toolRun.aggregate({
        where: { name: "__chat_turn__" },
        _count: { id: true },
        _sum: { durationMs: true },
      }),
      this.database.prisma.modelProvider.aggregate({ _sum: { requestCount: true, failureCount: true } }),
      this.database.prisma.reportDelivery.count({ where: { status: "FAILED" } }),
      this.database.prisma.shop.findMany({
        where: { status: "ACTIVE" },
        select: {
          fuduoShopId: true,
          dataSyncStates: {
            where: { tradeDate: today, dataType: { in: ["sales", "orders", "refunds"] } },
            select: { dataType: true, lastSuccessAt: true },
          },
        },
      }),
    ]);
    const duration = syncDuration[0];
    const modelTotal = modelRuns._sum.requestCount ?? 0;
    const modelFailed = modelRuns._sum.failureCount ?? 0;
    const now = Date.now();
    return [
      "# HELP sync_job_duration_seconds Completed synchronization job duration.",
      "# TYPE sync_job_duration_seconds summary",
      `sync_job_duration_seconds_count ${metricNumber(duration?.count)}`,
      `sync_job_duration_seconds_sum ${metricNumber(duration?.sumSeconds)}`,
      "# HELP sync_job_failures_total Failed synchronization runs.",
      "# TYPE sync_job_failures_total counter",
      `sync_job_failures_total ${syncFailures}`,
      "# HELP credential_refresh_total Credential refresh runs by result.",
      "# TYPE credential_refresh_total counter",
      `credential_refresh_total{result="succeeded"} ${refreshSucceeded}`,
      `credential_refresh_total{result="failed"} ${refreshFailed}`,
      "# HELP tool_call_duration_seconds Recorded business tool duration.",
      "# TYPE tool_call_duration_seconds summary",
      `tool_call_duration_seconds_count ${toolRuns._count.id}`,
      `tool_call_duration_seconds_sum ${((toolRuns._sum.durationMs ?? 0) / 1_000).toFixed(6)}`,
      "# HELP agent_turn_duration_seconds Completed agent turn duration.",
      "# TYPE agent_turn_duration_seconds summary",
      `agent_turn_duration_seconds_count ${agentTurns._count.id}`,
      `agent_turn_duration_seconds_sum ${((agentTurns._sum.durationMs ?? 0) / 1_000).toFixed(6)}`,
      "# HELP model_requests_total Model requests by result.",
      "# TYPE model_requests_total counter",
      `model_requests_total{result="succeeded"} ${Math.max(0, modelTotal - modelFailed)}`,
      `model_requests_total{result="failed"} ${modelFailed}`,
      "# HELP channel_delivery_failures_total Failed report channel deliveries.",
      "# TYPE channel_delivery_failures_total counter",
      `channel_delivery_failures_total ${channelFailures}`,
      "# HELP data_freshness_age_seconds Seconds since each active shop and data type last synchronized successfully for the current Shanghai business date.",
      "# TYPE data_freshness_age_seconds gauge",
      ...shops.flatMap((shop) => ["sales", "orders", "refunds"].map((dataType) => {
        const state = shop.dataSyncStates.find((item) => item.dataType === dataType);
        const age = state?.lastSuccessAt ? Math.max(0, (now - state.lastSuccessAt.getTime()) / 1_000).toFixed(3) : "NaN";
        return `data_freshness_age_seconds{shop_id="${shop.fuduoShopId.toString()}",data_type="${dataType.toUpperCase()}"} ${age}`;
      })),
    ];
  }
}

function normalizeRoute(value: string) {
  const path = (value.split("?")[0] || "/").slice(0, 200);
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id")
    .replace(/\/(?=\d{4,}(?:\/|$))\d+/g, "/:id");
}

function escapeLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function metricNumber(value: bigint | number | string | undefined) {
  if (typeof value === "bigint") return value.toString();
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? String(Math.max(0, number)) : "0";
}
