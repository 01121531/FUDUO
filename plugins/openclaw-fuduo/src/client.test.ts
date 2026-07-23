import { describe, expect, it, vi } from "vitest";
import { FuduoToolClient } from "./client.js";

describe("FuduoToolClient", () => {
  it("sends the configured service token, trusted channel identity, and structured params", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Internal-Service-Token")).toBe("x".repeat(32));
      expect(headers.get("X-Channel-User-Id")).toBe("wx-user-1");
      expect(JSON.parse(String(init?.body))).toEqual({ limit: 3 });
      return new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const client = new FuduoToolClient({ apiBaseUrl: "https://internal.example/api", serviceToken: "x".repeat(32) }, fetchImpl as typeof fetch);
    await expect(client.invoke("rank_shops_by_sales", { limit: 3 }, undefined, "wx-user-1", {
      channel: "openclaw-weixin",
      accountId: "wx-account-1",
      externalMessageId: "message-1",
    })).resolves.toEqual({ ok: true });
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-Channel-Id")).toBe("openclaw-weixin");
    expect(headers.get("X-Channel-Account-Id")).toBe("wx-account-1");
    expect(headers.get("X-Channel-Message-Id")).toBe("message-1");
  });

  it("rejects non-http API schemes", () => {
    expect(() => new FuduoToolClient({ apiBaseUrl: "file:///etc/passwd", serviceToken: "x".repeat(32) })).toThrow("HTTP");
  });

  it("resolves an environment-backed service token without storing its value in config", async () => {
    const previous = process.env.FUDUO_TEST_SERVICE_TOKEN;
    process.env.FUDUO_TEST_SERVICE_TOKEN = "s".repeat(48);
    try {
      const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("X-Internal-Service-Token")).toBe("s".repeat(48));
        return new Response(JSON.stringify({ success: true, data: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      const client = new FuduoToolClient({
        apiBaseUrl: "http://api:3001/api",
        serviceToken: { source: "env", provider: "default", id: "FUDUO_TEST_SERVICE_TOKEN" },
      }, fetchImpl as typeof fetch);
      await expect(client.invoke("list_shops", {})).resolves.toEqual({ ok: true });
    } finally {
      if (previous === undefined) delete process.env.FUDUO_TEST_SERVICE_TOKEN;
      else process.env.FUDUO_TEST_SERVICE_TOKEN = previous;
    }
  });

  it("fails closed when an environment-backed token is unavailable", () => {
    delete process.env.FUDUO_MISSING_SERVICE_TOKEN;
    expect(() => new FuduoToolClient({
      apiBaseUrl: "http://api:3001/api",
      serviceToken: { source: "env", id: "FUDUO_MISSING_SERVICE_TOKEN" },
    })).toThrow("is not available");
  });
});
