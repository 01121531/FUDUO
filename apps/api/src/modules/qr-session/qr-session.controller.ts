import { Controller, Delete, Get, Inject, NotFoundException, Param, Post, Req, Sse } from "@nestjs/common";
import { ok } from "../../common/response.js";
import { QrSessionService } from "./qr-session.service.js";
import { AccessControlService } from "../auth/access-control.service.js";
import { RateLimit } from "../rate-limit/rate-limit.decorator.js";
import { AuditAction } from "../audit/audit.decorator.js";

interface AuthenticatedRequest { user?: { id: string } }

@Controller("fuduo/qr-sessions")
export class QrSessionController {
  constructor(
    @Inject(QrSessionService) private readonly sessions: QrSessionService,
    @Inject(AccessControlService) private readonly access: AccessControlService,
  ) {}

  @RateLimit({ name: "fuduo-qr-create", limit: 10, windowSeconds: 3_600, identity: "user" })
  @AuditAction({ action: "创建富多扫码授权", resource: "富多账号" })
  @Post()
  async create(@Req() request: AuthenticatedRequest) {
    const scope = await this.access.assertPermission(request.user?.id, "settings:erp");
    return ok(await this.sessions.create(scope.userId));
  }

  @Get(":id")
  get(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    const session = this.sessions.get(id, request.user?.id);
    if (!session) throw new NotFoundException("二维码登录会话不存在");
    return ok(session);
  }

  @Sse(":id/events")
  events(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    const events = this.sessions.events(id, request.user?.id);
    if (!events) throw new NotFoundException("二维码登录会话不存在");
    return events;
  }

  @AuditAction({ action: "取消富多扫码授权", resourceParam: "id" })
  @Delete(":id")
  async cancel(@Param("id") id: string, @Req() request: AuthenticatedRequest) {
    const session = await this.sessions.cancel(id, request.user?.id);
    if (!session) throw new NotFoundException("二维码登录会话不存在");
    return ok(session);
  }
}
