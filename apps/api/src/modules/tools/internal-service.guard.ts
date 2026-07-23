import { timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";

@Injectable()
export class InternalServiceGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (process.env.DEMO_MODE !== "false") return true;
    const configured = process.env.INTERNAL_SERVICE_TOKEN;
    if (!configured || configured.length < 32) throw new Error("INTERNAL_SERVICE_TOKEN must contain at least 32 characters");
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const provided = first(request.headers["x-internal-service-token"]);
    const authorization = first(request.headers.authorization);
    const value = provided ?? bearerToken(authorization);
    if (!value || !safeEqual(value, configured)) throw new UnauthorizedException("内部工具认证失败");
    return true;
  }
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function bearerToken(value: string | undefined) {
  const match = value?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1];
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
