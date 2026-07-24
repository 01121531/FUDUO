import { describe, expect, it, vi } from "vitest";
import { FuduoApiError, FuduoClient } from "./index";

describe("FuduoClient", () => {
  it("does not send authorization to the public QR endpoint", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            url: "https://login.work.weixin.qq.com/example",
            state: "state-1",
            redirectUri: "https://erp.fuduo8888.com/wecom-callback",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const client = new FuduoClient({ fetchImpl: fetchImpl as typeof fetch });
    await expect(client.getQrLogin()).resolves.toMatchObject({ state: "state-1" });
  });

  it("polls the public QR state without authorization and encodes the state", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain("/api/v1/auth/wecom/poll?state=state%2B1");
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return new Response(
        JSON.stringify({ success: true, data: { pollStatus: "PENDING", login: null } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const client = new FuduoClient({ fetchImpl: fetchImpl as typeof fetch });
    await expect(client.pollQrLogin("state+1")).resolves.toEqual({ pollStatus: "PENDING", login: null });
  });

  it("redacts token from thrown errors", async () => {
    const token = "secret-token-that-must-not-appear";
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ success: false, code: "BIZ_UNAUTHORIZED", message: "expired" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new FuduoClient({ getAccessToken: () => token, fetchImpl: fetchImpl as typeof fetch });
    await expect(client.listVisibleShops()).rejects.toBeInstanceOf(FuduoApiError);
    await client.listVisibleShops().catch((error: unknown) => {
      expect(String(error)).not.toContain(token);
    });
  });

  it("retries transient GET failures but never retries a POST by default", async () => {
    const getFetch = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { records: [] } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const getClient = new FuduoClient({ getAccessToken: () => "token", fetchImpl: getFetch as typeof fetch });
    await expect(getClient.listVisibleShops()).resolves.toMatchObject({ records: [] });
    expect(getFetch).toHaveBeenCalledTimes(2);

    const postFetch = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const postClient = new FuduoClient({ getAccessToken: () => "token", fetchImpl: postFetch as typeof fetch });
    await expect(postClient.prepareMerchantBackend(2255)).rejects.toBeInstanceOf(FuduoApiError);
    expect(postFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized responses before parsing or retaining them", async () => {
    const declaredFetch = vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "Content-Length": "5000001" },
    }));
    const declaredClient = new FuduoClient({ fetchImpl: declaredFetch as typeof fetch });
    await expect(declaredClient.getQrLogin()).rejects.toMatchObject({ code: "ERP_RESPONSE_TOO_LARGE" });

    const streamedFetch = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { value: "x".repeat(100) } }), { status: 200 }));
    const streamedClient = new FuduoClient({ fetchImpl: streamedFetch as typeof fetch, maxResponseBytes: 32 });
    await expect(streamedClient.getQrLogin()).rejects.toMatchObject({ code: "ERP_RESPONSE_TOO_LARGE" });
  });

  it("calls the verified aggregate order and after-sales contracts with bounded pagination", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(init?.method).toBe("POST");
      expect(body).toEqual({
        platformCode: "pinduoduo",
        businessShopId: 10218,
        startAt: "2026-07-20T16:00:00.000Z",
        endAt: "2026-07-21T15:59:59.999Z",
        page: 1,
        size: 100,
      });
      const record = String(url).includes("aftersales")
        ? { businessShopId: 10218, refundAmount: "12.34", platformOccurredAt: "2026-07-21T01:00:00Z" }
        : { businessShopId: 10218, payAmount: "88.50", orderStatus: 1, platformOccurredAt: "2026-07-21T01:00:00Z" };
      return new Response(JSON.stringify({
        success: true,
        data: { records: [record], total: "1", page: "1", size: "100" },
        traceId: null,
      }), { status: 200 });
    });
    const client = new FuduoClient({ getAccessToken: () => "token", fetchImpl: fetchImpl as typeof fetch });

    await expect(client.listOrders(10218, "2026-07-21T00:00:00+08:00", "2026-07-21T23:59:59.999+08:00")).resolves.toMatchObject({
      records: [{ payAmount: 88.5, orderStatus: 1 }], total: 1,
    });
    await expect(client.listAfterSales(10218, "2026-07-21T00:00:00+08:00", "2026-07-21T23:59:59.999+08:00")).resolves.toMatchObject({
      records: [{ refundAmount: 12.34 }], total: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries the explicitly idempotent order and after-sales POST queries", async () => {
    const responseFor = (url: string | URL | Request) => {
      const record = String(url).includes("aftersales")
        ? { businessShopId: 10218, refundAmount: "12.34", platformOccurredAt: "2026-07-21T01:00:00Z" }
        : { businessShopId: 10218, payAmount: "88.50", orderStatus: 1, platformOccurredAt: "2026-07-21T01:00:00Z" };
      return new Response(JSON.stringify({ success: true, data: { records: [record], total: 1, page: 1, size: 100 } }), { status: 200 });
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockImplementationOnce(async (url: string | URL | Request) => responseFor(url))
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockImplementationOnce(async (url: string | URL | Request) => responseFor(url));
    const client = new FuduoClient({ getAccessToken: () => "token", fetchImpl: fetchImpl as typeof fetch });

    await expect(client.listOrders(10218, "2026-07-21T00:00:00+08:00", "2026-07-21T23:59:59.999+08:00")).resolves.toMatchObject({ total: 1 });
    await expect(client.listAfterSales(10218, "2026-07-21T00:00:00+08:00", "2026-07-21T23:59:59.999+08:00")).resolves.toMatchObject({ total: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("rejects invalid aggregate list ranges before sending a request", async () => {
    const fetchImpl = vi.fn();
    const client = new FuduoClient({ getAccessToken: () => "token", fetchImpl: fetchImpl as typeof fetch });
    await expect(client.listOrders(10218, "invalid", "2026-07-21T23:59:59+08:00")).rejects.toMatchObject({ code: "ERP_REQUEST_INVALID" });
    await expect(client.listAfterSales(10218, "2026-07-22T00:00:00+08:00", "2026-07-21T23:59:59+08:00")).rejects.toMatchObject({ code: "ERP_REQUEST_INVALID" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed non-empty sales metrics instead of converting them to null", async () => {
    const response = (salesAmount: unknown, transactionCount: unknown) => new Response(JSON.stringify({
      success: true,
      data: { shopId: 10218, salesStatDate: "2026-07-21", salesAmount, transactionCount },
    }), { status: 200 });
    const malformedAmount = new FuduoClient({ getAccessToken: () => "token", fetchImpl: vi.fn(async () => response("not-a-number", 1)) as typeof fetch });
    const fractionalCount = new FuduoClient({ getAccessToken: () => "token", fetchImpl: vi.fn(async () => response("100.00", 1.9)) as typeof fetch });

    await expect(malformedAmount.getSalesLive(10218, "2026-07-21")).rejects.toMatchObject({ code: "ERP_RESPONSE_INVALID" });
    await expect(fractionalCount.getSalesLive(10218, "2026-07-21")).rejects.toMatchObject({ code: "ERP_RESPONSE_INVALID" });
  });
});
