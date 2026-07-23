import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawAdminServer, type OpenClawAdmin } from "./server.js";

const TOKEN = "test-service-token-with-at-least-32-characters";
const servers: ReturnType<typeof createOpenClawAdminServer>[] = [];
let manager: OpenClawAdmin;

beforeEach(() => {
  manager = {
    list: vi.fn(async () => ({ pending: [], approved: [] })),
    approve: vi.fn(async (code: string) => ({ externalUserId: `user:${code}` })),
    revoke: vi.fn(async (externalUserId: string) => ({ externalUserId, revoked: true })),
    send: vi.fn(async (externalUserId: string) => ({ externalUserId, messageId: "message-1" })),
    loginStatus: vi.fn(() => ({ status: "IDLE" })),
    loginStart: vi.fn(async (accountId?: string) => ({ status: "PENDING", accountId: accountId ?? null, qrDataUrl: "https://weixin.qq.com/qr" })),
    loginCancel: vi.fn(() => ({ status: "CANCELLED" })),
    loginVerify: vi.fn((code: string) => ({ status: "SCANNED", codeAccepted: code.length > 0 })),
  };
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("OpenClaw admin HTTP server", () => {
  it("exposes only health without the internal token", async () => {
    const baseUrl = await listen(manager);
    const health = await fetch(`${baseUrl}/health`);
    const unauthorized = await fetch(`${baseUrl}/pairings`);

    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    await expect(health.json()).resolves.toEqual({ status: "ok" });
    expect(unauthorized.status).toBe(401);
    await expect(unauthorized.json()).resolves.toEqual({ error: { code: "AUTH_UNAUTHORIZED", message: "未授权" } });
    expect(manager.list).not.toHaveBeenCalled();
  });

  it("separates liveness from dependency readiness without exposing details", async () => {
    const baseUrl = await listen(manager, async () => false);
    const live = await fetch(`${baseUrl}/health/live`);
    const ready = await fetch(`${baseUrl}/health/ready`);

    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: "ok" });
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toEqual({ status: "unavailable" });
  });

  it("routes authenticated list, approve, and revoke requests", async () => {
    const baseUrl = await listen(manager);
    const headers = { "X-Internal-Service-Token": TOKEN, "Content-Type": "application/json" };

    expect((await fetch(`${baseUrl}/pairings`, { headers })).status).toBe(200);
    expect((await fetch(`${baseUrl}/pairings/approve`, { method: "POST", headers, body: JSON.stringify({ code: "ABCDEFGH" }) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/pairings/revoke`, { method: "POST", headers, body: JSON.stringify({ externalUserId: "wechat-user-1" }) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/messages/send`, { method: "POST", headers, body: JSON.stringify({ externalUserId: "wechat-user-1@im.wechat", text: "日报" }) })).status).toBe(200);
    expect(manager.list).toHaveBeenCalledOnce();
    expect(manager.approve).toHaveBeenCalledWith("ABCDEFGH");
    expect(manager.revoke).toHaveBeenCalledWith("wechat-user-1");
    expect(manager.send).toHaveBeenCalledWith("wechat-user-1@im.wechat", "日报", undefined);
  });

  it("routes authenticated WeChat account login lifecycle requests", async () => {
    const baseUrl = await listen(manager);
    const headers = { "X-Internal-Service-Token": TOKEN, "Content-Type": "application/json" };

    expect((await fetch(`${baseUrl}/login/status`, { headers })).status).toBe(200);
    expect((await fetch(`${baseUrl}/login/start`, { method: "POST", headers })).status).toBe(200);
    expect((await fetch(`${baseUrl}/login/start`, { method: "POST", headers, body: JSON.stringify({ accountId: "company-wechat" }) })).status).toBe(200);
    expect((await fetch(`${baseUrl}/login/cancel`, { method: "POST", headers })).status).toBe(200);
    expect((await fetch(`${baseUrl}/login/verify`, { method: "POST", headers, body: JSON.stringify({ code: "123456" }) })).status).toBe(200);
    expect(manager.loginStatus).toHaveBeenCalledOnce();
    expect(manager.loginStart).toHaveBeenNthCalledWith(1, undefined);
    expect(manager.loginStart).toHaveBeenNthCalledWith(2, "company-wechat");
    expect(manager.loginCancel).toHaveBeenCalledOnce();
    expect(manager.loginVerify).toHaveBeenCalledWith("123456");
  });

  it("rejects invalid and oversized JSON bodies with stable errors", async () => {
    const baseUrl = await listen(manager);
    const headers = { "X-Internal-Service-Token": TOKEN, "Content-Type": "application/json" };
    const invalid = await fetch(`${baseUrl}/pairings/approve`, { method: "POST", headers, body: "{" });
    const oversized = await fetch(`${baseUrl}/pairings/approve`, { method: "POST", headers, body: JSON.stringify({ code: "x".repeat(16_384) }) });

    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: { code: "REQUEST_INVALID", message: "请求参数无效" } });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ error: { code: "REQUEST_TOO_LARGE", message: "请求内容过大" } });
    expect(manager.approve).not.toHaveBeenCalled();
  });

  it("maps known pairing failures and hides unexpected exceptions", async () => {
    manager.approve = vi.fn(async () => { throw new Error("PAIRING_CODE_NOT_FOUND"); });
    manager.revoke = vi.fn(async () => { throw new Error("sensitive filesystem path"); });
    const baseUrl = await listen(manager);
    const headers = { "X-Internal-Service-Token": TOKEN, "Content-Type": "application/json" };
    const missing = await fetch(`${baseUrl}/pairings/approve`, { method: "POST", headers, body: JSON.stringify({ code: "ABCDEFGH" }) });
    const unexpected = await fetch(`${baseUrl}/pairings/revoke`, { method: "POST", headers, body: JSON.stringify({ externalUserId: "wechat-user-1" }) });

    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: { code: "PAIRING_CODE_NOT_FOUND", message: "配对码不存在或已过期" } });
    expect(unexpected.status).toBe(500);
    await expect(unexpected.json()).resolves.toEqual({ error: { code: "SYSTEM_INTERNAL", message: "服务处理请求时发生错误" } });
  });
});

async function listen(manager: OpenClawAdmin, readiness?: () => Promise<boolean>) {
  const server = createOpenClawAdminServer(manager, TOKEN, readiness);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
