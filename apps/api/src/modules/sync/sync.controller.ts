import { Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, Req } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsDateString, IsIn, IsOptional, IsString, Matches } from "class-validator";
import { ok } from "../../common/response.js";
import { BusinessDataService } from "../data/business-data.service.js";
import { SyncQueueService } from "./sync-queue.service.js";
import { AccessControlService } from "../auth/access-control.service.js";
import { AuditAction } from "../audit/audit.decorator.js";

interface AuthenticatedRequest { user?: { id: string } }

class CreateSyncRunDto {
  @IsOptional()
  @IsString()
  @IsIn(["shop-catalog-sync", "sales-live-sync", "sales-reconcile", "orders-sync", "refunds-sync", "credential-refresh"])
  type?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  tradeDate?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Matches(/^\d{1,19}$/, { each: true })
  shopIds?: string[];
}

@Controller("sync")
export class SyncController {
  constructor(
    @Inject(BusinessDataService) private readonly data: BusinessDataService,
    @Inject(SyncQueueService) private readonly queue: SyncQueueService,
    @Inject(AccessControlService) private readonly access: AccessControlService,
  ) {}

  @AuditAction({ action: "查询同步记录", resource: "同步中心" })
  @Get("runs")
  async runs(@Req() request: AuthenticatedRequest) {
    const allowed = await this.access.readableShopIds(request.user?.id);
    return ok(await this.data.syncRuns(allowed));
  }

  @Get("status")
  async status(@Req() request: AuthenticatedRequest) {
    await this.access.assertPermission(request.user?.id, "data:read");
    return ok(await this.queue.status());
  }

  @AuditAction({ action: "查询同步详情", resourceParam: "id" })
  @Get("runs/:id")
  async detail(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    const allowed = await this.access.readableShopIds(request.user?.id);
    const run = await this.data.syncRun(id, allowed);
    if (!run) throw new NotFoundException("同步任务不存在");
    return ok(run);
  }

  @AuditAction({ action: "发起数据同步", resource: "同步中心" })
  @Post("runs")
  async create(@Body() body: CreateSyncRunDto, @Req() request: AuthenticatedRequest) {
    const scope = await this.access.assertPermission(request.user?.id, "sync:run");
    if (isGlobalSyncType(body.type ?? "sales-live-sync") && !scope.permissions.includes("*")) {
      throw new ForbiddenException("只有管理员可以执行全局维护任务");
    }
    const allowed = await this.access.readableShopIds(request.user?.id, body.shopIds ?? []);
    return ok(await this.queue.enqueue(body.type ?? "sales-live-sync", body.tradeDate, allowed ?? body.shopIds, scope.userId));
  }

  @AuditAction({ action: "重试同步任务", resourceParam: "id" })
  @Post("runs/:id/retry")
  async retry(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    const scope = await this.access.assertPermission(request.user?.id, "sync:run");
    const allowed = await this.access.readableShopIds(request.user?.id);
    const run = await this.data.syncRun(id, allowed);
    if (!run) throw new NotFoundException("同步任务不存在");
    if (isGlobalSyncType(run.type) && !scope.permissions.includes("*")) {
      throw new ForbiddenException("只有管理员可以重试全局维护任务");
    }
    return ok(await this.queue.retry(id, run.scopeAllShops ? undefined : run.payload.shopIds, scope.userId));
  }
}

function isGlobalSyncType(type: string) {
  return type === "shop-catalog-sync" || type === "credential-refresh";
}
