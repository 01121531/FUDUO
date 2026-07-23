import { describe, expect, it, vi } from "vitest";
import { notifyErpReauthRequired } from "./credential-alert.js";

const options = (fetchImpl: typeof fetch) => ({ apiUrl: "http://api:3001/api", token: "x".repeat(48), fetchImpl });

describe("ERP reauthorization alert", () => {
  it("sends one internal alert and extends successful deduplication", async () => {
    const redis = new FakeRedis();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://api:3001/api/internal/alerts/erp-reauth");
      expect(new Headers(init?.headers).get("X-Internal-Service-Token")).toBe("x".repeat(48));
      return new Response(JSON.stringify({ success: true, data: { total: 1, sent: 1, failed: 0 } }), { status: 200 });
    });

    await expect(notifyErpReauthRequired(redis as never, 7, options(fetchImpl as typeof fetch))).resolves.toEqual({
      notified: true,
      deduplicated: false,
      total: 1,
      sent: 1,
      failed: 0,
    });
    expect(redis.extended).toBe(true);
    await expect(notifyErpReauthRequired(redis as never, 7, options(fetchImpl as typeof fetch))).resolves.toEqual({ notified: false, deduplicated: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps a short dedupe window when no administrator can be notified", async () => {
    const redis = new FakeRedis();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { total: 0, sent: 0, failed: 0 } }), { status: 200 }));
    await expect(notifyErpReauthRequired(redis as never, 8, options(fetchImpl as typeof fetch))).resolves.toMatchObject({ notified: false, total: 0 });
    expect(redis.extended).toBe(false);
  });

  it("rejects invalid credential versions before contacting internal services", async () => {
    const fetchImpl = vi.fn();
    await expect(notifyErpReauthRequired(new FakeRedis() as never, -1, options(fetchImpl as typeof fetch))).rejects.toThrow("ERP_CREDENTIAL_VERSION_INVALID");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

class FakeRedis {
  private readonly values = new Map<string, string>();
  extended = false;

  async set(key: string, value: string) {
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async eval(_script: string, _keys: number, key: string, owner: string) {
    if (this.values.get(key) !== owner) return 0;
    this.extended = true;
    return 1;
  }
}
