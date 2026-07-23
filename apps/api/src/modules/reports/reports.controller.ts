import { randomUUID } from "node:crypto";
import { Body, Controller, ForbiddenException, Get, Inject, InternalServerErrorException, NotFoundException, Patch, Post, Param, Req } from "@nestjs/common";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator";
import { REPORT_CRON_PATTERN, REPORT_TIMEZONE } from "@fuduo/shared";
import { ok } from "../../common/response.js";
import { DatabaseService } from "../database/database.service.js";
import { BusinessToolService } from "../tools/business-tool.service.js";
import { AccessControlService } from "../auth/access-control.service.js";
import { buildWechatReportPreview, parseReportSnapshotData, type ReportSnapshotData } from "./report-view.js";
import { AuditAction } from "../audit/audit.decorator.js";

interface AuthenticatedRequest { user?: { id: string } }

class GenerateReportDto {
  @IsIn(["DAILY", "WEEKLY"]) type!: "DAILY" | "WEEKLY";
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) date?: string;
}

class CreateScheduleDto {
  @IsIn(["DAILY", "WEEKLY"]) type!: "DAILY" | "WEEKLY";
  @IsString() @MaxLength(100) @Matches(REPORT_CRON_PATTERN) cron!: string;
  @IsOptional() @IsIn([REPORT_TIMEZONE]) timezone?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(50) @Matches(/^\d{1,19}$/, { each: true }) shopIds?: string[];
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(2) @IsIn(["WEB", "WECHAT"], { each: true }) channels?: string[];
}

class UpdateScheduleDto {
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MaxLength(100) @Matches(REPORT_CRON_PATTERN) cron?: string;
}

@Controller("reports")
export class ReportsController {
  private readonly demoReports = createDemoReports();
  private readonly demoSchedules = [
    { id: "demo-schedule-daily", type: "DAILY", cron: "0 30 8 * * *", timezone: REPORT_TIMEZONE, active: true, shopIds: [] as string[], channels: ["WEB", "WECHAT"], createdAt: new Date("2026-07-21T00:00:00.000Z"), updatedAt: new Date("2026-07-21T00:00:00.000Z") },
    { id: "demo-schedule-weekly", type: "WEEKLY", cron: "0 0 9 * * 1", timezone: REPORT_TIMEZONE, active: true, shopIds: [] as string[], channels: ["WEB", "WECHAT"], createdAt: new Date("2026-07-21T00:00:00.000Z"), updatedAt: new Date("2026-07-21T00:00:00.000Z") },
  ];
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(BusinessToolService) private readonly tools: BusinessToolService,
    @Inject(AccessControlService) private readonly access: AccessControlService,
  ) {}

  @AuditAction({ action: "查询报表列表", resource: "经营报表" })
  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    const scope = await this.access.assertPermission(request.user?.id, "reports:read");
    if (!this.database.enabled) {
      return ok(this.demoReports.map(({ data, ...report }) => ({
        ...report,
        shopCount: data.shops.length,
        freshness: data.freshness,
        partial: data.partial,
        deliveryStatus: aggregateWechatDeliveryStatus(report.deliveries),
      })));
    }
    const candidates = await this.database.prisma.reportSnapshot.findMany({
      orderBy: { createdAt: "desc" },
      take: scope.allShops ? 100 : 500,
      include: { deliveries: { select: { channel: true, status: true } } },
    });
    const reports = scope.allShops ? candidates : candidates.filter((report) => canReadScopedReport(report.shopIds, scope.shopIds)).slice(0, 100);
    return ok(reports.map((report) => {
      const metadata = reportSnapshotMetadata(report.data);
      return {
        id: report.id,
        type: report.type,
        periodStart: report.periodStart.toISOString().slice(0, 10),
        periodEnd: report.periodEnd.toISOString().slice(0, 10),
        version: report.version,
        shopCount: report.shopIds.length || null,
        deliveryStatus: aggregateWechatDeliveryStatus(report.deliveries),
        dataAsOf: metadata.dataAsOf,
        freshness: metadata.freshness,
        partial: metadata.partial,
        createdAt: report.createdAt.toISOString(),
      };
    }));
  }

  @Post("generate")
  async generate(@Body() body: GenerateReportDto, @Req() request: AuthenticatedRequest): Promise<unknown> {
    const name = body.type === "DAILY" ? "generate_daily_report" : "generate_weekly_report";
    const params = body.type === "DAILY" ? { date: body.date } : { weekStart: body.date };
    const generated = await this.tools.invoke(name, Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined)), request.user?.id ? { userId: request.user.id } : {});
    if (!this.database.enabled) {
      const data = parseReportSnapshotData(generated);
      const priorVersion = this.demoReports
        .filter((report) => report.type === body.type && report.periodStart === data.period.startDate && report.periodEnd === data.period.endDate)
        .reduce((latest, report) => Math.max(latest, report.version), 0);
      const created: ReportRecord = {
        id: `demo-${body.type.toLowerCase()}-${randomUUID()}`,
        type: body.type,
        periodStart: data.period.startDate,
        periodEnd: data.period.endDate,
        version: priorVersion + 1,
        shopIds: data.shops.map((shop) => shop.shopId),
        dataAsOf: data.dataAsOf ?? new Date(0).toISOString(),
        createdAt: new Date().toISOString(),
        data,
        deliveries: [],
      };
      this.demoReports.unshift(created);
      return ok(reportDetail(created));
    }
    return ok(generated);
  }

  @Get("schedules")
  async schedules(@Req() request: AuthenticatedRequest) {
    await this.assertScheduleManager(request.user?.id);
    if (!this.database.enabled) return ok(this.demoSchedules);
    return ok(await this.database.prisma.scheduledReport.findMany({ orderBy: { createdAt: "asc" } }));
  }

  @AuditAction({ action: "查询报表详情", resourceParam: "id" })
  @Get(":id")
  async detail(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    const scope = await this.access.assertPermission(request.user?.id, "reports:read");
    if (!this.database.enabled) {
      const report = this.demoReports.find((item) => item.id === id);
      if (!report) throw new NotFoundException("报表不存在");
      return ok(reportDetail(report));
    }
    if (!isUuid(id)) throw new NotFoundException("报表不存在");
    const report = await this.database.prisma.reportSnapshot.findUnique({ where: { id }, include: { deliveries: true } });
    if (!report || (!scope.allShops && !canReadScopedReport(report.shopIds, scope.shopIds))) throw new NotFoundException("报表不存在");
    try {
      return ok(reportDetail({
        id: report.id,
        type: reportType(report.type),
        periodStart: report.periodStart.toISOString().slice(0, 10),
        periodEnd: report.periodEnd.toISOString().slice(0, 10),
        version: report.version,
        shopIds: report.shopIds,
        dataAsOf: report.dataAsOf.toISOString(),
        createdAt: report.createdAt.toISOString(),
        data: parseReportSnapshotData(report.data),
        deliveries: report.deliveries,
      }));
    } catch (error) {
      if (error instanceof InternalServerErrorException) throw error;
      throw new InternalServerErrorException("报表快照数据格式无效");
    }
  }

  @Post("schedules")
  async createSchedule(@Body() body: CreateScheduleDto, @Req() request: AuthenticatedRequest) {
    await this.assertScheduleManager(request.user?.id);
    const shopIds = [...new Set(body.shopIds ?? [])];
    const channels = [...new Set(body.channels ?? ["WEB", "WECHAT"])];
    if (!this.database.enabled) {
      const now = new Date();
      const schedule = { id: `demo-schedule-${randomUUID()}`, type: body.type, cron: body.cron, timezone: body.timezone ?? REPORT_TIMEZONE, active: true, shopIds, channels, createdAt: now, updatedAt: now };
      this.demoSchedules.push(schedule);
      return ok(schedule);
    }
    await this.validateScheduleShops(shopIds);
    const schedule = await this.database.prisma.$transaction(async (transaction) => {
      const created = await transaction.scheduledReport.create({ data: { type: body.type, cron: body.cron, timezone: body.timezone ?? REPORT_TIMEZONE, shopIds, channels } });
      await transaction.auditLog.create({ data: { userId: request.user!.id, channel: "WEB", action: "创建定时报表", resource: created.id, result: "SUCCEEDED", traceId: randomUUID(), params: { type: body.type, shopCount: shopIds.length, channels } } });
      return created;
    });
    return ok(schedule);
  }

  @Patch("schedules/:id")
  async updateSchedule(@Param("id") id: string, @Body() body: UpdateScheduleDto, @Req() request: AuthenticatedRequest) {
    await this.assertScheduleManager(request.user?.id);
    if (!this.database.enabled) {
      const schedule = this.demoSchedules.find((item) => item.id === id);
      if (!schedule) throw new Error("REPORT_SCHEDULE_NOT_FOUND");
      if (body.active !== undefined) schedule.active = body.active;
      if (body.cron !== undefined) schedule.cron = body.cron;
      schedule.updatedAt = new Date();
      return ok(schedule);
    }
    const schedule = await this.database.prisma.$transaction(async (transaction) => {
      const updated = await transaction.scheduledReport.update({ where: { id }, data: body });
      await transaction.auditLog.create({ data: { userId: request.user!.id, channel: "WEB", action: "更新定时报表", resource: id, result: "SUCCEEDED", traceId: randomUUID(), params: { ...(body.active !== undefined ? { active: body.active } : {}), ...(body.cron ? { cron: body.cron } : {}) } } });
      return updated;
    });
    return ok(schedule);
  }

  private async assertScheduleManager(userId?: string) {
    const scope = await this.access.scope(userId);
    if (!scope.permissions.includes("*") && !scope.permissions.includes("settings:reports")) throw new ForbiddenException("需要报表调度权限");
  }

  private async validateScheduleShops(shopIds: string[]) {
    if (!shopIds.length) return;
    const count = await this.database.prisma.shop.count({ where: { fuduoShopId: { in: shopIds.map(BigInt) }, status: { not: "ARCHIVED" } } });
    if (count !== shopIds.length) throw new Error("REPORT_SCHEDULE_SHOP_INVALID");
  }
}

export function canReadScopedReport(reportShopIds: string[], allowedShopIds: string[]) {
  if (reportShopIds.length === 0) return false;
  const allowed = new Set(allowedShopIds);
  return reportShopIds.every((shopId) => allowed.has(shopId));
}

interface ReportRecord {
  id: string;
  type: "DAILY" | "WEEKLY";
  periodStart: string;
  periodEnd: string;
  version: number;
  shopIds: string[];
  dataAsOf: string;
  createdAt: string;
  data: ReportSnapshotData;
  deliveries?: ReportDeliveryRecord[];
}

interface ReportDeliveryRecord {
  id?: string;
  channel: string;
  recipient?: string;
  status: string;
  attempts?: number;
  errorCode?: string | null;
  lastAttemptAt?: Date | string | null;
  sentAt?: Date | string | null;
}

function reportDetail(report: ReportRecord) {
  const deliveries = report.deliveries ?? [];
  return {
    ...report,
    dataAsOf: report.data.dataAsOf,
    shopCount: report.data.shops.length,
    freshness: report.data.freshness,
    partial: report.data.partial,
    deliveryStatus: aggregateWechatDeliveryStatus(deliveries),
    deliveries: deliveries.map((delivery) => ({
      ...(delivery.id ? { id: delivery.id } : {}),
      channel: delivery.channel,
      recipient: maskRecipient(delivery.channel, delivery.recipient),
      status: delivery.status,
      attempts: delivery.attempts ?? 0,
      errorCode: delivery.errorCode ?? null,
      lastAttemptAt: dateValue(delivery.lastAttemptAt),
      sentAt: dateValue(delivery.sentAt),
    })),
    previews: { wechat: buildWechatReportPreview(report.type, report.periodStart, report.periodEnd, report.data) },
  };
}

function reportSnapshotMetadata(value: unknown) {
  try {
    const data = parseReportSnapshotData(value);
    return { freshness: data.freshness, partial: data.partial, dataAsOf: data.dataAsOf };
  } catch {
    // Older or damaged rows stay visible in the index, but are never presented
    // as complete/fresh. Detail still rejects the malformed immutable payload.
    return { freshness: "UNKNOWN" as const, partial: true, dataAsOf: null };
  }
}

export function aggregateWechatDeliveryStatus(deliveries: Array<{ channel: string; status: string }> = []) {
  const wechat = deliveries.filter((delivery) => delivery.channel === "WECHAT");
  if (!wechat.length) return "NOT_SENT";
  if (wechat.every((delivery) => delivery.status === "SUCCEEDED")) return "SENT";
  if (wechat.some((delivery) => delivery.status === "QUEUED" || delivery.status === "SENDING")) return "PENDING";
  if (wechat.some((delivery) => delivery.status === "FAILED")) return "FAILED";
  return "FAILED";
}

function maskRecipient(channel: string, recipient?: string) {
  if (channel === "WEB") return "Web";
  if (!recipient) return "未知接收人";
  const separator = recipient.indexOf("@");
  const local = separator >= 0 ? recipient.slice(0, separator) : recipient;
  const suffix = separator >= 0 ? recipient.slice(separator) : "";
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}***${suffix}`;
}

function dateValue(value?: Date | string | null) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function reportType(value: string): "DAILY" | "WEEKLY" {
  if (value === "DAILY" || value === "WEEKLY") return value;
  throw new InternalServerErrorException("报表类型无效");
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function createDemoReports(): ReportRecord[] {
  const daily = demoReport("demo-daily", "DAILY", "2026-07-21", "2026-07-21", 1, "2026-07-21T08:35:00.000Z", "2026-07-21T09:00:00.000Z");
  daily.deliveries = [
    { id: "demo-delivery-web", channel: "WEB", recipient: "web", status: "SUCCEEDED", attempts: 1, lastAttemptAt: "2026-07-21T09:00:00.000Z", sentAt: "2026-07-21T09:00:00.000Z" },
    { id: "demo-delivery-wechat", channel: "WECHAT", recipient: "employee@im.wechat", status: "SUCCEEDED", attempts: 1, lastAttemptAt: "2026-07-21T09:00:01.000Z", sentAt: "2026-07-21T09:00:02.000Z" },
  ];
  const weekly = demoReport("demo-weekly", "WEEKLY", "2026-07-13", "2026-07-19", 6.6, "2026-07-20T00:30:00.000Z", "2026-07-20T01:00:00.000Z");
  weekly.deliveries = [{ id: "demo-delivery-weekly", channel: "WECHAT", recipient: "employee@im.wechat", status: "QUEUED", attempts: 0 }];
  return [daily, weekly];
}

function demoReport(id: string, type: "DAILY" | "WEEKLY", periodStart: string, periodEnd: string, multiplier: number, dataAsOf: string, createdAt: string): ReportRecord {
  const source = [
    ["10218", "云野生活馆", 18642.3, 328, 642.8],
    ["10232", "拾光家居", 15480.2, 271, 388.5],
    ["10257", "简物优选", 12690.45, 206, 521.2],
    ["10271", "晴川百货", 8642, 142, 292],
    ["10305", "良品日用", 7328.6, 119, 165.8],
  ] as const;
  const shops = source.map(([shopId, shopName, sales, orders, refunds], index) => {
    const salesAmount = roundMoney(sales * multiplier);
    const transactionCount = Math.round(orders * multiplier);
    const payBuyerCount = Math.round(transactionCount * 0.93);
    return { shopId, shopName, salesAmount, transactionCount, payBuyerCount, refundAmount: roundMoney(refunds * multiplier), averageOrderValue: transactionCount ? roundMoney(salesAmount / transactionCount) : null, freshness: index === 3 ? "STALE" as const : "LIVE" as const, dataAsOf, missing: false };
  });
  const salesAmount = roundMoney(shops.reduce((sum, shop) => sum + shop.salesAmount, 0));
  const transactionCount = shops.reduce((sum, shop) => sum + shop.transactionCount, 0);
  const payBuyerCount = shops.reduce((sum, shop) => sum + shop.payBuyerCount, 0);
  const refundAmount = roundMoney(shops.reduce((sum, shop) => sum + shop.refundAmount, 0));
  const data = parseReportSnapshotData({ period: { startDate: periodStart, endDate: periodEnd }, shops, summary: { salesAmount, transactionCount, payBuyerCount, refundAmount, averageOrderValue: roundMoney(salesAmount / transactionCount) }, freshness: "STALE", dataAsOf, partial: false, missingShops: [] });
  return { id, type, periodStart, periodEnd, version: 1, shopIds: shops.map((shop) => shop.shopId), dataAsOf, createdAt, data };
}

function roundMoney(value: number) { return Math.round(value * 100) / 100; }
