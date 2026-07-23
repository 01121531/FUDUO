import { randomUUID } from "node:crypto";
import { Body, Controller, ForbiddenException, Get, Inject, Optional, Post, Query, Req } from "@nestjs/common";
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";
import { ok } from "../../common/response.js";
import { DatabaseService } from "../database/database.service.js";
import { OpenClawAdminService } from "./openclaw-admin.service.js";
import { AccessControlService } from "../auth/access-control.service.js";
import {
  normalizeWechatNickname,
  resolveWechatPairingStatus,
} from "./wechat-pairing.js";

interface AuthenticatedRequest { user?: { id: string; email: string; displayName: string } }

class ApproveWechatPairingDto {
  @IsString() @Matches(/^[A-HJ-NP-Z2-9]{8}$/i) code!: string;
  @IsUUID() userId!: string;
}

class RevokeWechatPairingDto {
  @IsString() @MaxLength(256) externalUserId!: string;
}

class StartWechatLoginDto {
  @IsOptional() @IsString() @MaxLength(256) accountId?: string;
}

class SubmitWechatVerifyCodeDto {
  @IsString() @Matches(/^\d{4,8}$/) code!: string;
}

const demoAuditEvents = [
  { id: "demo-audit-1", createdAt: "2026-07-21T08:35:22.000Z", user: "系统管理员", channel: "WEB", action: "查询经营概览", resource: "全部店铺", result: "SUCCEEDED", durationMs: 182, traceId: "e72f-demo-9c1a", tool: null, params: { period: "today", shopIds: [] } },
  { id: "demo-audit-2", createdAt: "2026-07-21T08:34:12.000Z", user: "系统任务", channel: "WORKER", action: "同步当日销售", resource: "5 家店铺", result: "SUCCEEDED", durationMs: 1_823, traceId: "a918-demo-42dd", tool: "sales-live-sync", params: { tradeDate: "2026-07-21", shopCount: 5 } },
  { id: "demo-audit-3", createdAt: "2026-07-21T08:25:03.000Z", user: "系统任务", channel: "WORKER", action: "同步当日销售", resource: "晴川百货", result: "PARTIAL", durationMs: 3_220, traceId: "8b30-demo-c904", tool: "sales-live-sync", params: { tradeDate: "2026-07-21", shopName: "晴川百货" } },
];

@Controller("settings")
export class SettingsController {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OpenClawAdminService) private readonly openclawAdmin: OpenClawAdminService,
    @Optional() @Inject(AccessControlService) private readonly access?: AccessControlService,
  ) {}

  @Get("audit")
  async audit(
    @Query("search") rawSearch?: string,
    @Query("channel") rawChannel?: string,
    @Query("result") rawResult?: string,
    @Query("user") rawUser?: string,
    @Query("tool") rawTool?: string,
    @Query("shop") rawShop?: string,
    @Query("start") rawStart?: string,
    @Query("end") rawEnd?: string,
    @Query("limit") rawLimit?: string,
    @Req() request: AuthenticatedRequest = {},
  ) {
    if (this.access) await this.access.assertPermission(request.user?.id, "settings:audit");
    const search = (rawSearch ?? "").trim().slice(0, 100).toLocaleLowerCase("zh-CN");
    const channel = (rawChannel ?? "").trim().toUpperCase();
    const result = (rawResult ?? "").trim().toUpperCase();
    const filters = {
      search,
      channel,
      result,
      user: normalizeFilter(rawUser),
      tool: normalizeFilter(rawTool),
      shop: normalizeFilter(rawShop),
      start: normalizeDateFilter(rawStart),
      end: normalizeDateFilter(rawEnd),
    };
    const limit = clampLimit(rawLimit);
    if (!this.database.enabled) return ok(filterAudit(demoAuditEvents, filters).slice(0, limit));

    const [auditLogs, toolRuns] = await Promise.all([
      this.database.prisma.auditLog.findMany({ include: { user: true }, orderBy: { createdAt: "desc" }, take: 200 }),
      this.database.prisma.toolRun.findMany({ include: { user: true }, orderBy: { createdAt: "desc" }, take: 200 }),
    ]);
    const events = [
      ...auditLogs.map((entry) => ({
        id: entry.id,
        createdAt: entry.createdAt.toISOString(),
        user: entry.user?.displayName ?? "系统任务",
        channel: entry.channel.toUpperCase(),
        action: entry.action,
        resource: entry.resource,
        result: entry.result,
        durationMs: entry.durationMs,
        traceId: entry.traceId,
        tool: null,
        params: redactAuditValue(entry.params),
      })),
      ...toolRuns.map((entry) => ({
        id: entry.id,
        createdAt: entry.createdAt.toISOString(),
        user: entry.user?.displayName ?? "系统任务",
        channel: entry.userId ? "WEB" : "OPENCLAW",
        action: `工具调用：${entry.name}`,
        resource: entry.dataAsOf ? `数据截止 ${entry.dataAsOf.toISOString()}` : null,
        result: entry.status,
        durationMs: entry.durationMs,
        traceId: entry.id,
        tool: entry.name,
        params: redactAuditValue({ params: entry.params, result: entry.resultMeta }),
      })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return ok(filterAudit(events, filters).slice(0, limit));
  }

  @Get("wechat")
  async wechat(@Req() request: AuthenticatedRequest = {}) {
    if (this.access) await this.access.assertPermission(request.user?.id, "settings:wechat");
    const [runtime, login] = this.openclawAdmin.configured
      ? await Promise.all([this.openclawAdmin.list().catch(() => null), this.openclawAdmin.loginStatus().catch(() => null)])
      : [null, null];
    const pairings = !this.database.enabled ? [] : await this.database.prisma.channelUser.findMany({
      where: { revokedAt: null },
      include: { user: true, channelAccount: true },
      orderBy: { pairedAt: "desc" },
    });
    return ok({
      gatewayStatus: process.env.OPENCLAW_GATEWAY_URL ? "CONFIGURED" : "NOT_CONFIGURED",
      plugin: "@tencent-weixin/openclaw-weixin",
      channel: "openclaw-weixin",
      directMessages: true,
      groupChats: false,
      managementStatus: runtime ? "CONNECTED" : this.openclawAdmin.configured ? "UNAVAILABLE" : "NOT_CONFIGURED",
      login,
      pending: (runtime?.pending ?? []).map((request) => ({
        ...request,
        wechatNickname: normalizeWechatNickname(request.meta),
        pairingStatus: "PENDING" as const,
      })),
      approvedUnbound: (runtime?.approved ?? [])
        .filter((externalUserId) => !pairings.some((pairing) => pairing.externalUserId === externalUserId))
        .map((externalUserId) => ({
          externalUserId,
          wechatNickname: null,
          pairingStatus: "UNBOUND" as const,
        })),
      pairings: pairings.map((pairing) => ({
        id: pairing.id,
        wechatNickname: pairing.externalDisplayName,
        internalUser: {
          id: pairing.user.id,
          displayName: pairing.user.displayName,
          email: pairing.user.email,
        },
        externalUserId: pairing.externalUserId,
        pairingStatus: resolveWechatPairingStatus(runtime, pairing.externalUserId),
        pairedAt: pairing.pairedAt.toISOString(),
      })),
    });
  }

  @Get("wechat/login/status")
  async wechatLoginStatus(@Req() request: AuthenticatedRequest = {}) {
    await this.assertAdmin(request.user?.id);
    return ok(await this.openclawAdmin.loginStatus());
  }

  @Post("wechat/login/start")
  async startWechatLogin(@Body() body: StartWechatLoginDto, @Req() request: AuthenticatedRequest) {
    await this.assertAdmin(request.user?.id);
    return ok(await this.openclawAdmin.loginStart(body.accountId?.trim() || undefined));
  }

  @Post("wechat/login/cancel")
  async cancelWechatLogin(@Req() request: AuthenticatedRequest) {
    await this.assertAdmin(request.user?.id);
    return ok(await this.openclawAdmin.loginCancel());
  }

  @Post("wechat/login/verify")
  async verifyWechatLogin(@Body() body: SubmitWechatVerifyCodeDto, @Req() request: AuthenticatedRequest) {
    await this.assertAdmin(request.user?.id);
    return ok(await this.openclawAdmin.loginVerify(body.code));
  }

  @Post("wechat/pairings/approve")
  async approveWechatPairing(@Body() body: ApproveWechatPairingDto, @Req() request: AuthenticatedRequest) {
    await this.assertAdmin(request.user?.id);
    if (!this.database.enabled) throw new Error("WECHAT_DATABASE_REQUIRED");
    const user = await this.database.prisma.user.findFirst({ where: { id: body.userId, active: true } });
    if (!user) throw new Error("WECHAT_USER_NOT_FOUND");
    const approved = await this.openclawAdmin.approve(body.code);
    const wechatNickname = normalizeWechatNickname(approved.meta);
    try {
      const pairing = await this.database.prisma.$transaction(async (transaction) => {
        const account = await transaction.channelAccount.upsert({
          where: { channel_externalId: { channel: "openclaw-weixin", externalId: "default" } },
          create: { channel: "openclaw-weixin", externalId: "default", displayName: "公司微信" },
          update: { active: true },
        });
        const linked = await transaction.channelUser.upsert({
          where: { channelAccountId_externalUserId: { channelAccountId: account.id, externalUserId: approved.externalUserId } },
          create: {
            channelAccountId: account.id,
            externalUserId: approved.externalUserId,
            externalDisplayName: wechatNickname,
            userId: user.id,
          },
          update: {
            userId: user.id,
            ...(wechatNickname ? { externalDisplayName: wechatNickname } : {}),
            revokedAt: null,
          },
        });
        await transaction.auditLog.create({
          data: { userId: request.user!.id, channel: "WEB", action: "批准微信配对", resource: user.displayName, result: "SUCCEEDED", traceId: randomUUID() },
        });
        return linked;
      });
      return ok({
        id: pairing.id,
        externalUserId: pairing.externalUserId,
        wechatNickname,
        internalUser: {
          id: user.id,
          displayName: user.displayName,
          email: user.email,
        },
        pairingStatus: "PAIRED" as const,
        pairedAt: pairing.pairedAt.toISOString(),
      });
    } catch (error) {
      await this.openclawAdmin.revoke(approved.externalUserId).catch(() => undefined);
      throw error;
    }
  }

  @Post("wechat/pairings/revoke")
  async revokeWechatPairing(@Body() body: RevokeWechatPairingDto, @Req() request: AuthenticatedRequest) {
    await this.assertAdmin(request.user?.id);
    if (!this.database.enabled) throw new Error("WECHAT_DATABASE_REQUIRED");
    const runtime = await this.openclawAdmin.revoke(body.externalUserId);
    await this.database.prisma.$transaction([
      this.database.prisma.channelUser.updateMany({
        where: { externalUserId: body.externalUserId, revokedAt: null, channelAccount: { channel: "openclaw-weixin" } },
        data: { revokedAt: new Date() },
      }),
      this.database.prisma.auditLog.create({
        data: { userId: request.user!.id, channel: "WEB", action: "撤销微信配对", resource: body.externalUserId, result: "SUCCEEDED", traceId: randomUUID() },
      }),
    ]);
    return ok(runtime);
  }

  private async assertAdmin(userId?: string) {
    if (!this.database.enabled) return;
    if (!userId) throw new ForbiddenException("需要管理员权限");
    const roles = await this.database.prisma.userRole.findMany({ where: { userId }, include: { role: true } });
    if (!roles.some((entry) => entry.role.permissions.includes("*") || entry.role.permissions.includes("settings:wechat"))) {
      throw new ForbiddenException("需要管理员权限");
    }
  }
}

function clampLimit(value?: string) {
  const parsed = Number(value ?? 100);
  return Number.isInteger(parsed) ? Math.min(200, Math.max(1, parsed)) : 100;
}

function filterAudit<T extends {
  createdAt: string;
  user: string;
  channel: string;
  action: string;
  resource: string | null;
  result: string;
  traceId: string;
  tool: string | null;
  params: unknown;
}>(events: T[], filters: {
  search: string;
  channel: string;
  result: string;
  user: string;
  tool: string;
  shop: string;
  start: string;
  end: string;
}) {
  return events.filter((event) => {
    if (filters.channel && event.channel !== filters.channel) return false;
    if (filters.result && event.result !== filters.result) return false;
    if (filters.user && !event.user.toLocaleLowerCase("zh-CN").includes(filters.user)) return false;
    if (filters.tool && !(event.tool ?? "").toLocaleLowerCase("zh-CN").includes(filters.tool)) return false;
    if (filters.shop && ![event.resource ?? "", JSON.stringify(event.params)].some((value) => value.toLocaleLowerCase("zh-CN").includes(filters.shop))) return false;
    const businessDate = event.createdAt.slice(0, 10);
    if (filters.start && businessDate < filters.start) return false;
    if (filters.end && businessDate > filters.end) return false;
    if (!filters.search) return true;
    return [event.user, event.action, event.resource ?? "", event.traceId, event.tool ?? ""]
      .some((value) => value.toLocaleLowerCase("zh-CN").includes(filters.search));
  });
}

function normalizeFilter(value?: string) {
  return (value ?? "").trim().slice(0, 100).toLocaleLowerCase("zh-CN");
}

function normalizeDateFilter(value?: string) {
  const normalized = (value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

function redactAuditValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactAuditValue(item, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    /authorization|cookie|token|api[-_]?key|secret|password/i.test(key) ? "[REDACTED]" : redactAuditValue(item, depth + 1),
  ]));
}
