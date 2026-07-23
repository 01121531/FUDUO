import { randomUUID } from "node:crypto";
import { CallHandler, ExecutionContext, Inject, Injectable, type NestInterceptor } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { catchError, from, map, mergeMap, Observable, throwError } from "rxjs";
import { DatabaseService } from "../database/database.service.js";
import { AUDIT_POLICY, type AuditPolicy } from "./audit.decorator.js";

interface AuditedRequest extends FastifyRequest {
  traceId?: string;
  user?: { id: string };
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const policy = this.reflector.getAllAndOverride<AuditPolicy>(AUDIT_POLICY, [context.getHandler(), context.getClass()]);
    if (!policy || !this.database.enabled) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<AuditedRequest>();
    const reply = http.getResponse<FastifyReply>();
    const started = Date.now();

    return next.handle().pipe(
      mergeMap((value) => from(this.write(policy, request, reply.statusCode, "SUCCEEDED", started)).pipe(map(() => value))),
      catchError((error: unknown) => from(this.write(policy, request, httpStatus(error), "FAILED", started)).pipe(
        mergeMap(() => throwError(() => error)),
      )),
    );
  }

  private async write(policy: AuditPolicy, request: AuditedRequest, statusCode: number, result: "SUCCEEDED" | "FAILED", started: number) {
    const route = request.routeOptions?.url ?? "unknown";
    const resource = resolveResource(policy, request.params);
    const traceId = request.traceId ?? randomUUID();
    try {
      await this.database.prisma.auditLog.create({
        data: {
          ...(request.user?.id ? { userId: request.user.id } : {}),
          channel: "WEB",
          action: policy.action,
          resource,
          result,
          traceId,
          durationMs: Math.max(0, Date.now() - started),
          params: { method: request.method, route, statusCode },
        },
      });
    } catch {
      process.stderr.write(`${JSON.stringify({
        level: "error",
        event: "audit.write.failed",
        action: policy.action,
        route,
        traceId,
        at: new Date().toISOString(),
      })}\n`);
    }
  }
}

function resolveResource(policy: AuditPolicy, rawParams: unknown) {
  if (policy.resource) return policy.resource;
  if (!policy.resourceParam || !rawParams || typeof rawParams !== "object") return null;
  const value = (rawParams as Record<string, unknown>)[policy.resourceParam];
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 200 ? normalized : null;
}

function httpStatus(error: unknown) {
  if (error && typeof error === "object" && "getStatus" in error && typeof error.getStatus === "function") {
    const status = Number(error.getStatus());
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  return 500;
}
