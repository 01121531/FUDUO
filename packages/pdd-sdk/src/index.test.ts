import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PddApiError, PddClient } from "./index";

const schema = z.object({ success: z.boolean() });
const session = {
  cookie: "[REDACTED_COOKIE]",
  userAgent: "FixtureBrowser/1.0",
};

describe("PddClient", () => {
  it("sends the controlled Cookie and UA only to an allowlisted HTTPS host", async () => {
    const transport = vi.fn(async (url: URL, init: RequestInit) => {
      const headers = new Headers(init.headers);
      expect(url.toString()).toBe("https://mms.pinduoduo.com/api/orders?page=1");
      expect(headers.get("Cookie")).toBe(session.cookie);
      expect(headers.get("User-Agent")).toBe(session.userAgent);
      expect(init.redirect).toBe("error");
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    const client = new PddClient({ getSession: () => session, transport });
    await expect(client.request({ path: "/api/orders", query: { page: 1 }, schema })).resolves.toEqual({ success: true });
    expect(() => new PddClient({ baseUrl: "http://mms.pinduoduo.com", getSession: () => session })).toThrow("PDD_BASE_URL_NOT_ALLOWED");
    expect(() => new PddClient({ baseUrl: "https://127.0.0.1", getSession: () => session })).toThrow("PDD_BASE_URL_NOT_ALLOWED");
  });

  it("does not allow callers to replace Cookie, Authorization, or the target path", async () => {
    const client = new PddClient({ getSession: () => session, transport: vi.fn() });
    await expect(client.request({ path: "/api/orders", headers: { Cookie: "[REDACTED_COOKIE_OVERRIDE]" }, schema })).rejects.toMatchObject({ code: "PDD_HEADER_NOT_ALLOWED" });
    await expect(client.request({ path: "https://example.com/internal", schema })).rejects.toMatchObject({ code: "PDD_PATH_INVALID" });
  });

  it("refuses direct replay when the prepared session requires a fixed proxy outlet", async () => {
    const client = new PddClient({ getSession: () => ({ ...session, proxy: { required: true, endpoint: "https://proxy.example/session" } }) });
    await expect(client.request({ path: "/api/orders", schema })).rejects.toEqual(expect.objectContaining<PddApiError>({ code: "PDD_PROXY_TRANSPORT_REQUIRED" }));
  });

  it("validates responses and retries GET but not POST", async () => {
    const getTransport = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await expect(new PddClient({ getSession: () => session, transport: getTransport }).request({ path: "/api/orders", schema })).resolves.toEqual({ success: true });
    expect(getTransport).toHaveBeenCalledTimes(2);

    const postTransport = vi.fn(async () => new Response("unavailable", { status: 503 }));
    await expect(new PddClient({ getSession: () => session, transport: postTransport }).request({ method: "POST", path: "/api/orders", body: {}, schema })).rejects.toMatchObject({ code: "PDD_REQUEST_FAILED" });
    expect(postTransport).toHaveBeenCalledTimes(1);
  });

  it("normalizes missing and malformed sessions into stable API errors", async () => {
    const missing = new PddClient({ getSession: () => null, transport: vi.fn() });
    await expect(missing.request({ path: "/api/orders", schema })).rejects.toMatchObject({ code: "PDD_SESSION_MISSING", status: 401 });

    const malformed = new PddClient({ getSession: () => ({ cookie: "", userAgent: "" }), transport: vi.fn() });
    await expect(malformed.request({ path: "/api/orders", schema })).rejects.toMatchObject({ code: "PDD_SESSION_INVALID", status: 401 });
  });

  it("honors Retry-After for a rate-limited GET", async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn()
        .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "Retry-After": "1" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));
      const pending = new PddClient({ getSession: () => session, transport }).request({ path: "/api/orders", schema });
      await vi.advanceTimersByTimeAsync(999);
      expect(transport).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ success: true });
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases unsuccessful responses and enforces the JSON byte limit", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("denied")); },
      cancel,
    });
    const failed = new PddClient({ getSession: () => session, transport: vi.fn(async () => new Response(stream, { status: 400 })) });
    await expect(failed.request({ path: "/api/orders", schema })).rejects.toMatchObject({ code: "PDD_REQUEST_FAILED" });
    expect(cancel).toHaveBeenCalledOnce();

    const oversized = new PddClient({
      getSession: () => session,
      transport: vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Length": "5000001" } })),
    });
    await expect(oversized.request({ path: "/api/orders", schema })).rejects.toMatchObject({ code: "PDD_RESPONSE_TOO_LARGE" });
  });
});
