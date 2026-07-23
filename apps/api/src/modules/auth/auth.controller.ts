import { Body, Controller, Delete, Get, Inject, Optional, Param, ParseUUIDPipe, Post, Req, Res } from "@nestjs/common";
import { IsEmail, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, MinLength } from "class-validator";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ok } from "../../common/response.js";
import { AuthService } from "./auth.service.js";
import { Public } from "./public.decorator.js";
import { AccessControlService } from "./access-control.service.js";
import { RateLimit } from "../rate-limit/rate-limit.decorator.js";
import { AuditAction } from "../audit/audit.decorator.js";
import { AllowSessionStates } from "./session-state.decorator.js";
import type { AuthSessionState } from "@fuduo/database";

class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(8) password!: string;
}

class TotpDto {
  @IsString() @MinLength(20) challengeId!: string;
  @IsString() @Length(6, 6) code!: string;
}

class TotpSetupDto {
  @IsString() @MinLength(8) currentPassword!: string;
  @IsOptional() @IsString() @Length(6, 6) @Matches(/^\d{6}$/) currentCode?: string;
}

class TotpConfirmDto {
  @IsUUID() enrollmentId!: string;
  @IsString() @Length(6, 6) @Matches(/^\d{6}$/) code!: string;
}

class ChangePasswordDto {
  @IsString() @MinLength(8) @MaxLength(128) currentPassword!: string;
  @IsString() @MinLength(12) @MaxLength(128) newPassword!: string;
}

interface AuthenticatedRequest extends FastifyRequest {
  user?: { id: string; email: string; displayName: string; sessionId: string; sessionState: AuthSessionState };
}

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Optional() @Inject(AccessControlService) private readonly access?: AccessControlService,
  ) {}

  @Public()
  @RateLimit({ name: "auth-login", limit: 5, windowSeconds: 300, identity: "ip" })
  @AuditAction({ action: "内部账号登录", resource: "管理后台" })
  @Post("login")
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.passwordLogin(body.email, body.password);
    if ("session" in result && result.session) setSessionCookie(reply, result.session);
    return ok(withoutSession(result));
  }

  @Public()
  @RateLimit({ name: "auth-totp-verify", limit: 10, windowSeconds: 300, identity: "ip" })
  @AuditAction({ action: "验证动态验证码", resource: "管理后台" })
  @Post("totp/verify")
  async totp(@Body() body: TotpDto, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.auth.verifyTotp(body.challengeId, body.code);
    setSessionCookie(reply, result.session);
    return ok({ user: result.user, nextAction: result.nextAction, expiresAt: result.session.expiresAt.toISOString() });
  }

  @AllowSessionStates("ACTIVE", "PASSWORD_CHANGE_REQUIRED", "TOTP_ENROLLMENT_REQUIRED")
  @AuditAction({ action: "退出内部账号", resource: "管理后台" })
  @Post("logout")
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = request.cookies?.fuduo_session;
    reply.clearCookie("fuduo_session", { path: "/" });
    return ok(await this.auth.logout(token));
  }

  @AllowSessionStates("ACTIVE", "PASSWORD_CHANGE_REQUIRED", "TOTP_ENROLLMENT_REQUIRED")
  @Get("me")
  async me(@Req() request: AuthenticatedRequest) {
    if (!request.user) return ok({ id: "demo-user", email: "admin@example.com", displayName: "系统管理员", permissions: ["*"], sessionState: "ACTIVE", nextAction: "NONE" });
    const active = request.user.sessionState === "ACTIVE";
    const scope = active && this.access ? await this.access.scope(request.user.id) : { permissions: [] };
    return ok({ id: request.user.id, email: request.user.email, displayName: request.user.displayName, permissions: scope.permissions, sessionState: request.user.sessionState, nextAction: sessionNextAction(request.user.sessionState) });
  }

  @AllowSessionStates("ACTIVE", "PASSWORD_CHANGE_REQUIRED", "TOTP_ENROLLMENT_REQUIRED")
  @Get("security")
  async security(@Req() request: AuthenticatedRequest) {
    return ok(await this.auth.securityStatus(request.user?.id));
  }

  @AllowSessionStates("ACTIVE", "TOTP_ENROLLMENT_REQUIRED")
  @RateLimit({ name: "auth-totp-setup", limit: 10, windowSeconds: 600, identity: "user" })
  @Post("totp/setup")
  async setupTotp(@Body() body: TotpSetupDto, @Req() request: AuthenticatedRequest) {
    return ok(await this.auth.beginTotpEnrollment(request.user?.id, body.currentPassword, body.currentCode));
  }

  @AllowSessionStates("ACTIVE", "TOTP_ENROLLMENT_REQUIRED")
  @RateLimit({ name: "auth-totp-confirm", limit: 10, windowSeconds: 600, identity: "user" })
  @Post("totp/confirm")
  async confirmTotp(@Body() body: TotpConfirmDto, @Req() request: AuthenticatedRequest) {
    return ok(await this.auth.confirmTotpEnrollment(request.user?.id, request.user?.sessionId, body.enrollmentId, body.code));
  }

  @AllowSessionStates("ACTIVE", "TOTP_ENROLLMENT_REQUIRED")
  @Delete("totp/setup/:enrollmentId")
  async cancelTotp(@Param("enrollmentId", ParseUUIDPipe) enrollmentId: string, @Req() request: AuthenticatedRequest) {
    return ok(await this.auth.cancelTotpEnrollment(request.user?.id, enrollmentId));
  }

  @AllowSessionStates("ACTIVE", "PASSWORD_CHANGE_REQUIRED", "TOTP_ENROLLMENT_REQUIRED")
  @RateLimit({ name: "auth-password-change", limit: 5, windowSeconds: 600, identity: "user" })
  @AuditAction({ action: "修改登录密码", resource: "管理后台" })
  @Post("password/change")
  async changePassword(@Body() body: ChangePasswordDto, @Req() request: AuthenticatedRequest) {
    return ok(await this.auth.changePassword(request.user?.id, request.user?.sessionId, body.currentPassword, body.newPassword));
  }
}

function setSessionCookie(reply: FastifyReply, session: { token: string; expiresAt: Date }) {
  reply.setCookie("fuduo_session", session.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    expires: session.expiresAt,
  });
}

function withoutSession(result: { requiresTotp: boolean; nextAction: string; challengeId?: string; expiresAt?: string; demo?: boolean; session?: { expiresAt: Date } }) {
  return {
    requiresTotp: result.requiresTotp,
    nextAction: result.nextAction,
    ...(result.challengeId ? { challengeId: result.challengeId } : {}),
    ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
    ...(result.demo ? { demo: true } : {}),
    ...(result.session ? { sessionExpiresAt: result.session.expiresAt.toISOString() } : {}),
  };
}

function sessionNextAction(state: AuthSessionState) {
  if (state === "PASSWORD_CHANGE_REQUIRED") return "CHANGE_PASSWORD";
  if (state === "TOTP_ENROLLMENT_REQUIRED") return "TOTP_ENROLL";
  return "NONE";
}
