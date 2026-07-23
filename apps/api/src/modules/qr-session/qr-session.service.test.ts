import { describe, expect, it, vi } from "vitest";
import {
  QrSessionService,
  isAllowedAuthBrowserUrl,
  isTrustedFuduoCallbackUrl,
  isTrustedQrLoginUrl,
  interpretQrLoginPoll,
} from "./qr-session.service.js";

describe("QR login session recovery", () => {
  it("turns non-terminal database sessions into recoverable failures after a restart", async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const findMany = vi.fn(async () => [{
      id: "3e5f76fb-cb4b-46b8-bb40-d85bed12cbad",
      ownerId: "cf8eef72-dafb-4f09-a368-fb26f3f2d806",
      status: "FAILED",
      expiresAt: new Date(Date.now() + 60_000),
      accountName: null,
      shopCount: null,
      errorCode: "AUTH_BROWSER_SESSION_INTERRUPTED",
      errorMessage: "云端登录会话因服务重启而中断",
      errorRecovery: "请生成新二维码后重新扫码",
      updatedAt: new Date(),
    }]);
    const service = new QrSessionService(
      {} as never,
      { enabled: true, prisma: { loginSession: { updateMany, deleteMany, findMany } } } as never,
    );

    await service.onModuleInit();

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: { in: ["CREATED", "WAITING_SCAN", "SCANNED", "VERIFYING"] } },
    }));
    expect(service.get("3e5f76fb-cb4b-46b8-bb40-d85bed12cbad", "cf8eef72-dafb-4f09-a368-fb26f3f2d806"))
      .toMatchObject({ status: "FAILED", error: { code: "AUTH_BROWSER_SESSION_INTERRUPTED" } });
  });

  it("keeps only one global authorization session active", async () => {
    const service = new QrSessionService({} as never);
    const internals = service as unknown as {
      startBrowserSession(session: unknown): Promise<void>;
    };
    internals.startBrowserSession = vi.fn(async () => undefined);

    const first = await service.create("admin-a");
    const second = await service.create("admin-b");

    expect(service.get(first.id, "admin-a")).toMatchObject({ status: "CANCELLED" });
    expect(service.get(second.id, "admin-b")).toMatchObject({ status: "CREATED" });
    await service.cancel(second.id, "admin-b");
  });

  it("does not report cancellation after credential commit has started", async () => {
    let resolveImport!: (value: { accountName: string; shopCount: number }) => void;
    const importToken = vi.fn(() => new Promise<{ accountName: string; shopCount: number }>((resolve) => { resolveImport = resolve; }));
    const service = new QrSessionService({ importToken } as never);
    const internals = service as unknown as {
      startBrowserSession(session: unknown): Promise<void>;
      acceptToken(session: unknown, token: string): Promise<void>;
      sessions: Map<string, unknown>;
    };
    internals.startBrowserSession = vi.fn(async () => undefined);
    const created = await service.create("admin-a");
    const accepting = internals.acceptToken(internals.sessions.get(created.id), "opaque-token");
    await vi.waitFor(() => expect(importToken).toHaveBeenCalledOnce());

    const cancelling = service.cancel(created.id, "admin-a");
    resolveImport({ accountName: "富多账号", shopCount: 3 });

    await accepting;
    await expect(cancelling).resolves.toMatchObject({ status: "SUCCESS" });
  });
});

describe("QR authorization browser URL policy", () => {
  it("accepts the observed WeCom login entry and exact Fuduo callback", () => {
    expect(isTrustedQrLoginUrl("https://login.work.weixin.qq.com/wwlogin/sso/login?state=test")).toBe(true);
    expect(isTrustedQrLoginUrl("https://open.work.weixin.qq.com/wwopen/sso/qrConnect?state=test")).toBe(true);
    expect(isTrustedFuduoCallbackUrl("https://erp.fuduo8888.com/wecom-callback?token=opaque")).toBe(true);
  });

  it("rejects deceptive hosts, downgraded protocols, credentials, and unrelated Fuduo paths", () => {
    expect(isTrustedQrLoginUrl("https://login.work.weixin.qq.com.attacker.example/login")).toBe(false);
    expect(isTrustedQrLoginUrl("http://login.work.weixin.qq.com/login")).toBe(false);
    expect(isTrustedQrLoginUrl("https://user:pass@login.work.weixin.qq.com/login")).toBe(false);
    expect(isTrustedFuduoCallbackUrl("https://erp.fuduo8888.com.attacker.example/wecom-callback?token=opaque")).toBe(false);
    expect(isTrustedFuduoCallbackUrl("https://erp.fuduo8888.com/shops?token=opaque")).toBe(false);
    expect(isTrustedFuduoCallbackUrl("http://erp.fuduo8888.com/wecom-callback?token=opaque")).toBe(false);
  });

  it("allows only HTTPS resources from the authorization domain families", () => {
    expect(isAllowedAuthBrowserUrl("https://wwcdn.weixin.qq.com/node/wwopen/wwopenmng/js/ssoLogin.js")).toBe(true);
    expect(isAllowedAuthBrowserUrl("https://www.tencent.com/favicon.ico")).toBe(true);
    expect(isAllowedAuthBrowserUrl("https://erp.fuduo8888.com/wecom-callback")).toBe(true);
    expect(isAllowedAuthBrowserUrl("data:image/png;base64,AA==")).toBe(true);
    expect(isAllowedAuthBrowserUrl("http://127.0.0.1:3001/api/internal")).toBe(false);
    expect(isAllowedAuthBrowserUrl("https://metadata.google.internal/computeMetadata/v1/")).toBe(false);
    expect(isAllowedAuthBrowserUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedAuthBrowserUrl("https://fuduo8888.com.attacker.example/collect")).toBe(false);
  });
});

describe("QR login polling result", () => {
  it("keeps waiting while Fuduo reports PENDING", () => {
    expect(interpretQrLoginPoll({ pollStatus: "PENDING", login: null })).toEqual({ kind: "PENDING" });
    expect(interpretQrLoginPoll({ pollStatus: "SCANNED", login: null })).toEqual({ kind: "SCANNED" });
    expect(interpretQrLoginPoll({ pollStatus: "CONFIRMING", login: null })).toEqual({ kind: "SCANNED" });
  });

  it("accepts the access token returned by the current Fuduo polling protocol", () => {
    expect(interpretQrLoginPoll({ pollStatus: "OK", login: { accessToken: "opaque-token" } })).toEqual({
      kind: "TOKEN",
      token: "opaque-token",
    });
    expect(interpretQrLoginPoll({ pollStatus: "SUCCESS", login: { accessToken: "fixture-token" } })).toEqual({
      kind: "TOKEN",
      token: "fixture-token",
    });
  });

  it("turns terminal results without a token into actionable failures", () => {
    expect(interpretQrLoginPoll({ pollStatus: "DISABLED", login: { disableReason: "账号已停用" } })).toMatchObject({
      kind: "FAILED",
      error: { code: "ERP_QR_DISABLED", recovery: "账号已停用" },
    });
    expect(interpretQrLoginPoll({ pollStatus: "OK", login: null })).toMatchObject({
      kind: "FAILED",
      error: { code: "ERP_QR_OK" },
    });
  });
});
