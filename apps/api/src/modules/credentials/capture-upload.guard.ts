import { createHmac, timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";

@Injectable()
export class CaptureUploadGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.CAPTURE_UPLOAD_SECRET;
    if (!secret || secret.length < 32) throw new Error("CAPTURE_UPLOAD_SECRET must contain at least 32 characters");
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      body?: { authorization?: unknown };
    }>();
    const timestamp = first(request.headers["x-capture-timestamp"]);
    const signature = first(request.headers["x-capture-signature"]);
    const authorization = request.body?.authorization;
    if (!timestamp || !signature || typeof authorization !== "string") throw new UnauthorizedException("捕获插件签名缺失");
    const time = Number(timestamp);
    if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60_000) throw new UnauthorizedException("捕获插件请求已过期");
    const expected = createHmac("sha256", secret).update(`${timestamp}.${authorization}`).digest("hex");
    if (!safeEqual(signature.toLowerCase(), expected)) throw new UnauthorizedException("捕获插件签名无效");
    return true;
  }
}

function first(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
function safeEqual(left: string, right: string) { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
