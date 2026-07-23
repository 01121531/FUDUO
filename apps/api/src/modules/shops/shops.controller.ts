import { BadRequestException, Controller, Get, Inject, NotFoundException, Optional, Param, Query, Req } from "@nestjs/common";
import { ok } from "../../common/response.js";
import { BusinessDataService } from "../data/business-data.service.js";
import { AccessControlService } from "../auth/access-control.service.js";
import { AuditAction } from "../audit/audit.decorator.js";

interface AuthenticatedRequest { user?: { id: string } }

@Controller("shops")
export class ShopsController {
  constructor(
    @Inject(BusinessDataService) private readonly data: BusinessDataService,
    @Optional() @Inject(AccessControlService) private readonly access?: AccessControlService,
  ) {}

  @AuditAction({ action: "查询店铺列表", resource: "全部店铺" })
  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    const allowed = this.access ? await this.access.readableShopIds(request.user?.id) : null;
    return ok(await this.data.listShops(allowed));
  }

  @AuditAction({ action: "查询店铺详情", resourceParam: "id" })
  @Get(":id")
  async detail(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    const allowed = this.access ? await this.access.readableShopIds(request.user?.id, [id]) : null;
    const detail = await this.data.shopDetail(id, allowed);
    if (!detail) throw new NotFoundException("店铺不存在");
    return ok(detail);
  }

  @AuditAction({ action: "查询店铺销售", resourceParam: "id" })
  @Get(":id/sales")
  async sales(@Param("id") id: string, @Query("days") rawDays: string | undefined, @Req() request: AuthenticatedRequest) {
    const days = rawDays === undefined ? 30 : Number(rawDays);
    if (![7, 30, 90].includes(days)) throw new BadRequestException("仅支持近 7、30 或 90 天");
    const allowed = this.access ? await this.access.readableShopIds(request.user?.id, [id]) : null;
    const history = await this.data.shopHistory(id, days, allowed);
    if (!history) throw new NotFoundException("店铺不存在");
    return ok(history);
  }
}
