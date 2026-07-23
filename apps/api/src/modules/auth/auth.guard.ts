import { createHash, timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { DatabaseService } from "../database/database.service.js";
import { IS_PUBLIC } from "./public.decorator.js";
import { ALLOWED_SESSION_STATES } from "./session-state.decorator.js";
import type { AuthSessionState } from "@fuduo/database";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (process.env.DEMO_MODE === "true") return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;
    const request = context.switchToHttp().getRequest<{
      cookies?: Record<string, string>;
      headers: Record<string, string | string[] | undefined>;
      user?: { id: string; email: string; displayName: string; sessionId: string; sessionState: AuthSessionState };
    }>();
    const internal = first(request.headers["x-internal-service-token"]);
    if (internal && process.env.INTERNAL_SERVICE_TOKEN && safeEqual(internal, process.env.INTERNAL_SERVICE_TOKEN)) return true;

    const token = request.cookies?.fuduo_session;
    if (!token) throw new UnauthorizedException("请先登录");
    const session = await this.database.prisma.userSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now() || !session.user.active) {
      throw new UnauthorizedException("登录会话已失效");
    }
    const allowed = this.reflector.getAllAndOverride<AuthSessionState[]>(ALLOWED_SESSION_STATES, [context.getHandler(), context.getClass()]) ?? ["ACTIVE"];
    if (!allowed.includes(session.state)) throw new UnauthorizedException("请先完成账号安全设置");
    request.user = { id: session.user.id, email: session.user.email, displayName: session.user.displayName, sessionId: session.id, sessionState: session.state };
    if (Date.now() - session.lastSeenAt.getTime() > 5 * 60_000) {
      void this.database.prisma.userSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    }
    return true;
  }
}

export function hashToken(value: string) { return createHash("sha256").update(value).digest("hex"); }
function first(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
function safeEqual(left: string, right: string) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
