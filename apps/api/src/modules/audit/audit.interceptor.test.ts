import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { BadRequestException } from "@nestjs/common";
import { lastValueFrom, of, throwError, type Observable } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import type { AuditPolicy } from "./audit.decorator.js";
import { AuditInterceptor } from "./audit.interceptor.js";

const policy: AuditPolicy = { action: "查询店铺详情", resourceParam: "id" };

describe("AuditInterceptor", () => {
  it("writes a successful event without request bodies, query strings, or sensitive headers", async () => {
    const create = vi.fn(async () => ({ id: "audit-1" }));
    const interceptor = new AuditInterceptor(
      { getAllAndOverride: () => policy } as never,
      { enabled: true, prisma: { auditLog: { create } } } as never,
    );
    const request = {
      method: "GET",
      routeOptions: { url: "/api/shops/:id" },
      params: { id: "2255" },
      query: { token: "query-secret" },
      headers: { authorization: "Bearer header-secret", cookie: "session=secret" },
      body: { message: "private conversation" },
      user: { id: "00000000-0000-4000-8000-000000000001" },
      traceId: "trace-request-1",
    };

    await expect(lastValueFrom(interceptor.intercept(context(request, 200), handler(of({ ok: true }))))).resolves.toEqual({ ok: true });
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: request.user.id,
        channel: "WEB",
        action: "查询店铺详情",
        resource: "2255",
        result: "SUCCEEDED",
        traceId: "trace-request-1",
        durationMs: expect.any(Number),
        params: { method: "GET", route: "/api/shops/:id", statusCode: 200 },
      },
    });
    const stored = JSON.stringify(create.mock.calls[0]);
    expect(stored).not.toContain("query-secret");
    expect(stored).not.toContain("header-secret");
    expect(stored).not.toContain("session=secret");
    expect(stored).not.toContain("private conversation");
  });

  it("records failures and preserves the original business exception", async () => {
    const create = vi.fn(async () => ({ id: "audit-2" }));
    const interceptor = new AuditInterceptor(
      { getAllAndOverride: () => ({ action: "查询经营概览", resource: "全部店铺" }) } as never,
      { enabled: true, prisma: { auditLog: { create } } } as never,
    );
    const error = new BadRequestException("日期范围无效");

    await expect(lastValueFrom(interceptor.intercept(context({ method: "GET", routeOptions: { url: "/api/analytics/dashboard" }, headers: {} }, 200), handler(throwError(() => error))))).rejects.toBe(error);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "查询经营概览",
        resource: "全部店铺",
        result: "FAILED",
        params: { method: "GET", route: "/api/analytics/dashboard", statusCode: 400 },
      }),
    });
  });

  it("does not audit undecorated endpoints or demo-mode requests", async () => {
    const create = vi.fn();
    const noPolicy = new AuditInterceptor({ getAllAndOverride: () => undefined } as never, { enabled: true, prisma: { auditLog: { create } } } as never);
    const demo = new AuditInterceptor({ getAllAndOverride: () => policy } as never, { enabled: false, prisma: { auditLog: { create } } } as never);

    await expect(lastValueFrom(noPolicy.intercept(context({ headers: {} }, 200), handler(of("ok"))))).resolves.toBe("ok");
    await expect(lastValueFrom(demo.intercept(context({ headers: {} }, 200), handler(of("ok"))))).resolves.toBe("ok");
    expect(create).not.toHaveBeenCalled();
  });

  it("does not replace a successful response when audit persistence fails", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const interceptor = new AuditInterceptor(
      { getAllAndOverride: () => policy } as never,
      { enabled: true, prisma: { auditLog: { create: async () => { throw new Error("database unavailable"); } } } } as never,
    );

    await expect(lastValueFrom(interceptor.intercept(context({ method: "GET", routeOptions: { url: "/api/shops/:id" }, params: { id: "2255" }, headers: {} }, 200), handler(of("business-result"))))).resolves.toBe("business-result");
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"event":"audit.write.failed"'));
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("database unavailable"));
    stderr.mockRestore();
  });
});

function handler<T>(stream: Observable<T>): CallHandler<T> {
  return { handle: () => stream };
}

function context(request: Record<string, unknown>, statusCode: number): ExecutionContext {
  return {
    getHandler: () => function routeHandler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode }) }),
  } as never;
}
