import { BadRequestException, Controller, Get, Inject, Optional, Query, Req } from "@nestjs/common";
import { ok } from "../../common/response.js";
import { BusinessDataService } from "../data/business-data.service.js";
import { isDashboardPeriod, resolveDashboardRange, type DashboardPeriod, type DashboardRange } from "../data/dashboard-period.js";
import { AccessControlService } from "../auth/access-control.service.js";
import { AuditAction } from "../audit/audit.decorator.js";

interface AuthenticatedRequest { user?: { id: string } }

@Controller("analytics")
export class AnalyticsController {
  constructor(
    @Inject(BusinessDataService) private readonly data: BusinessDataService,
    @Optional() @Inject(AccessControlService) private readonly access?: AccessControlService,
  ) {}

  @AuditAction({ action: "查询经营概览", resource: "全部店铺" })
  @Get("dashboard")
  async dashboard(@Query("period") rawPeriod?: string, @Query("shopIds") rawShopIds?: string, @Query("start") start?: string, @Query("end") end?: string, @Req() request: AuthenticatedRequest = {}) {
    const period = parsePeriod(rawPeriod);
    const requested = parseShopIds(rawShopIds);
    const allowed = this.access ? await this.access.readableShopIds(request.user?.id, requested) : null;
    const data = await this.data.dashboard(period, requested, parseRange(period, start, end), allowed);
    return ok(data, { dataAsOf: data.dataAsOf, freshness: data.freshness });
  }

  @AuditAction({ action: "查询经营汇总", resource: "全部店铺" })
  @Get("summary")
  async summary(@Query("period") rawPeriod?: string, @Query("shopIds") rawShopIds?: string, @Query("start") start?: string, @Query("end") end?: string, @Req() request: AuthenticatedRequest = {}) {
    const period = parsePeriod(rawPeriod);
    const requested = parseShopIds(rawShopIds);
    const allowed = this.access ? await this.access.readableShopIds(request.user?.id, requested) : null;
    const data = await this.data.dashboard(period, requested, parseRange(period, start, end), allowed);
    return ok(data.summary, { dataAsOf: data.dataAsOf, freshness: data.freshness });
  }

  @AuditAction({ action: "查询店铺排名", resource: "全部店铺" })
  @Get("rankings")
  async rankings(@Query("period") rawPeriod?: string, @Query("shopIds") rawShopIds?: string, @Query("start") start?: string, @Query("end") end?: string, @Req() request: AuthenticatedRequest = {}) {
    const period = parsePeriod(rawPeriod);
    const requested = parseShopIds(rawShopIds);
    const allowed = this.access ? await this.access.readableShopIds(request.user?.id, requested) : null;
    const data = await this.data.dashboard(period, requested, parseRange(period, start, end), allowed);
    return ok(data.rankings, { dataAsOf: data.dataAsOf, freshness: data.freshness });
  }
}

function parsePeriod(value?: string): DashboardPeriod {
  if (value === undefined || value === "") return "today";
  if (!isDashboardPeriod(value)) throw new BadRequestException("不支持的统计周期");
  return value;
}

function parseShopIds(value?: string) {
  if (!value) return [];
  const ids = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (ids.length > 50 || ids.some((id) => !/^\d{1,19}$/.test(id) || BigInt(id) <= 0n)) {
    throw new BadRequestException("店铺筛选参数无效");
  }
  return ids;
}

function parseRange(period: DashboardPeriod, start?: string, end?: string): DashboardRange {
  try {
    return resolveDashboardRange(period, new Date(), period === "custom" ? { start: start ?? "", end: end ?? "" } : undefined);
  } catch (error) {
    const code = error instanceof Error ? error.message : "DASHBOARD_CUSTOM_RANGE_INVALID";
    const messages: Record<string, string> = {
      DASHBOARD_CUSTOM_RANGE_INVALID: "自定义日期格式无效",
      DASHBOARD_CUSTOM_RANGE_REVERSED: "开始日期不能晚于结束日期",
      DASHBOARD_CUSTOM_RANGE_FUTURE: "结束日期不能晚于今天",
      DASHBOARD_CUSTOM_RANGE_TOO_LARGE: "自定义日期范围不能超过 366 天",
    };
    throw new BadRequestException(messages[code] ?? "自定义日期范围无效");
  }
}
