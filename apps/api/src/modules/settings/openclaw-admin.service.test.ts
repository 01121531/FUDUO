import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenClawAdminClient } from "./openclaw-admin.service.js";

describe("OpenClawAdminClient", () => {
  afterEach(() => vi.useRealTimers());

  it("authenticates pairing requests without putting the token in the URL", async () => {
    const token = "x".repeat(48);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://openclaw-admin:18790/pairings");
      expect(new Headers(init?.headers).get("X-Internal-Service-Token")).toBe(token);
      return new Response(JSON.stringify({ pending: [], approved: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new OpenClawAdminClient("http://openclaw-admin:18790", token, fetchImpl as typeof fetch);
    await expect(client.list()).resolves.toEqual({ pending: [], approved: [] });
  });

  it("rejects arbitrary management hosts", () => {
    expect(() => new OpenClawAdminClient("https://example.com", "x".repeat(48))).toThrow("URL_INVALID");
  });

  it("sends report text in the authenticated request body", async () => {
    const token = "x".repeat(48);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://openclaw-admin:18790/messages/send");
      expect(String(url)).not.toContain("经营日报");
      expect(new Headers(init?.headers).get("X-Internal-Service-Token")).toBe(token);
      expect(JSON.parse(String(init?.body))).toEqual({ externalUserId: "employee@im.wechat", text: "经营日报" });
      return new Response(JSON.stringify({ messageId: "message-1" }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const client = new OpenClawAdminClient("http://openclaw-admin:18790", token, fetchImpl as typeof fetch);
    await expect(client.send("employee@im.wechat", "经营日报")).resolves.toEqual({ messageId: "message-1" });
  });

  it("starts and polls the WeChat account login lifecycle", async () => {
    const token = "x".repeat(48);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-Internal-Service-Token")).toBe(token);
      return new Response(JSON.stringify({ status: String(url).endsWith("/login/status") ? "IDLE" : "PENDING", qrDataUrl: "https://weixin.qq.com/qr" }), { status: 200 });
    });
    const client = new OpenClawAdminClient("http://openclaw-admin:18790", token, fetchImpl as typeof fetch);

    await expect(client.loginStatus()).resolves.toMatchObject({ status: "IDLE" });
    await expect(client.loginStart()).resolves.toMatchObject({ status: "PENDING" });
    expect(fetchImpl.mock.calls[1]?.[1]?.body).toBeUndefined();
  });

  it("submits a WeChat verification code in the authenticated body", async () => {
    const token = "x".repeat(48);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://openclaw-admin:18790/login/verify");
      expect(JSON.parse(String(init?.body))).toEqual({ code: "123456" });
      return new Response(JSON.stringify({ status: "SCANNED" }), { status: 200 });
    });
    const client = new OpenClawAdminClient("http://openclaw-admin:18790", token, fetchImpl as typeof fetch);
    await expect(client.loginVerify("123456")).resolves.toMatchObject({ status: "SCANNED" });
  });

  it("allows enough time for MCP registration and probe", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason)));
    });
    const client = new OpenClawAdminClient("http://openclaw-admin:18790", "x".repeat(48), fetchImpl as typeof fetch);
    const request = client.installExtension({ kind: "MCP", slug: "order-helper", version: 1, manifest: {}, files: [{ path: "server.mjs", content: "" }] });
    const rejection = expect(request).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(35_000);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });
});
