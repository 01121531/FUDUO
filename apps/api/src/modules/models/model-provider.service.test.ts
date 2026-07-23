import { afterEach, describe, expect, it, vi } from "vitest";
import { isPublicIpAddress, ModelProviderService, normalizeModelBaseUrl } from "./model-provider.service.js";
import { parseOpenClawCompletionRequest } from "./openclaw-model-proxy.js";

const originalDemoMode = process.env.DEMO_MODE;
const originalMasterKey = process.env.CREDENTIAL_MASTER_KEY_BASE64;
const originalAllowlist = process.env.MODEL_PROVIDER_HOST_ALLOWLIST;

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv("DEMO_MODE", originalDemoMode);
  restoreEnv("CREDENTIAL_MASTER_KEY_BASE64", originalMasterKey);
  restoreEnv("MODEL_PROVIDER_HOST_ALLOWLIST", originalAllowlist);
});

describe("ModelProviderService", () => {
  it("accepts only allowlisted HTTPS base URLs without credentials or request parameters", () => {
    expect(normalizeModelBaseUrl("https://api.openai.com/v1/"))
      .toBe("https://api.openai.com/v1");
    expect(() => normalizeModelBaseUrl("http://api.openai.com/v1")).toThrow("MODEL_BASE_URL_NOT_ALLOWED");
    expect(() => normalizeModelBaseUrl("https://user:secret@api.openai.com/v1")).toThrow("MODEL_BASE_URL_NOT_ALLOWED");
    expect(() => normalizeModelBaseUrl("https://api.openai.com/v1?target=internal")).toThrow("MODEL_BASE_URL_NOT_ALLOWED");
    expect(() => normalizeModelBaseUrl("https://unlisted.example/v1")).toThrow("MODEL_BASE_URL_NOT_ALLOWED");
  });

  it("rejects loopback, private, link-local, carrier NAT and documentation addresses", () => {
    expect(isPublicIpAddress("8.8.8.8")).toBe(true);
    expect(isPublicIpAddress("127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("10.1.2.3")).toBe(false);
    expect(isPublicIpAddress("100.64.1.1")).toBe(false);
    expect(isPublicIpAddress("169.254.1.1")).toBe(false);
    expect(isPublicIpAddress("192.168.1.1")).toBe(false);
    expect(isPublicIpAddress("::1")).toBe(false);
    expect(isPublicIpAddress("fd00::1")).toBe(false);
  });

  it("keeps API keys out of all management responses and disables assigned profiles with a provider", async () => {
    delete process.env.DEMO_MODE;
    const service = new ModelProviderService({ enabled: false } as never);
    const secret = "sk-demo-secret-value";
    const created = await service.create({
      name: "OpenAI",
      type: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: secret,
      defaultModel: "gpt-test",
    });
    await service.assignProfile("default_chat_model", created.id, "gpt-test");

    expect(JSON.stringify(await service.list())).not.toContain(secret);
    expect(await service.profiles()).toContainEqual(expect.objectContaining({ key: "default_chat_model", providerId: created.id, active: true }));

    await service.disable(created.id);
    expect(await service.profiles()).toContainEqual(expect.objectContaining({ key: "default_chat_model", active: false }));
    expect((await service.list()).find((provider) => provider.id === created.id)).toEqual(expect.objectContaining({ active: false, status: "已停用" }));
  });

  it("encrypts a production API key before persistence", async () => {
    process.env.DEMO_MODE = "false";
    process.env.CREDENTIAL_MASTER_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
    let storedData: Record<string, unknown> | null = null;
    const database = {
      enabled: true,
      prisma: {
        $transaction: async (operation: (transaction: unknown) => unknown) => operation({
          modelProvider: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
              storedData = data;
              return persistedProvider({ id: "11111111-1111-4111-8111-111111111111", ...data });
            },
          },
          auditLog: { create: async () => ({}) },
        }),
      },
    };
    const service = new ModelProviderService(database as never);
    const secret = "sk-production-secret";
    const result = await service.create({
      name: "OpenAI",
      type: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      apiKey: secret,
      defaultModel: "gpt-test",
    }, "22222222-2222-4222-8222-222222222222");

    expect(Buffer.from(storedData!.apiKeyCipher as Uint8Array).toString("utf8")).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.configured).toBe(true);
  });

  it("tests model discovery with redirects disabled", async () => {
    delete process.env.DEMO_MODE;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const service = new ModelProviderService({ enabled: false } as never);
    const provider = await service.create({ name: "OpenAI", type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test-value", defaultModel: "model-a" });
    const result = await service.test(provider.id);

    expect(result).toEqual(expect.objectContaining({ success: true, modelCount: 2 }));
    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/models", expect.objectContaining({ redirect: "error" }));
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer sk-test-value" }));
  });

  it("uses one fallback after a primary failure and records provider failure rates", async () => {
    delete process.env.DEMO_MODE;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("upstream failed", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "经营摘要" } }] }), { status: 200 }));
    const service = new ModelProviderService({ enabled: false } as never);
    const primary = await service.create({ name: "Primary", type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "sk-primary", defaultModel: "model-primary" });
    const fallback = await service.create({ name: "Fallback", type: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey: "sk-fallback", defaultModel: "model-fallback" });
    await service.assignProfile("default_chat_model", primary.id, "model-primary");
    await service.assignProfile("fallback_model", fallback.id, "model-fallback");

    await expect(service.complete("今天销售如何", { dataAsOf: "2026-07-21T00:00:00Z" })).resolves.toEqual({ content: "经营摘要", model: "Fallback/model-fallback" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const providers = await service.list();
    expect(providers.find((provider) => provider.id === primary.id)).toEqual(expect.objectContaining({ requestCount: 1, failureCount: 1, failureRate: 1 }));
    expect(providers.find((provider) => provider.id === fallback.id)).toEqual(expect.objectContaining({ requestCount: 1, failureCount: 0, failureRate: 0 }));
  });

  it("sends bounded conversation history before the current business context", async () => {
    delete process.env.DEMO_MODE;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "第二家店铺摘要" } }] }), { status: 200 }));
    const service = new ModelProviderService({ enabled: false } as never);
    const provider = await service.create({ name: "OpenAI", type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "sk-history", defaultModel: "model-history" });
    await service.assignProfile("default_chat_model", provider.id, "model-history");

    await service.complete("那第二家呢？", { shopId: "102" }, undefined, "default_chat_model", [
      { role: "user", content: "今天所有店铺销售额是多少？" },
      { role: "assistant", content: "第一家店铺销售额最高。" },
    ]);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.slice(1, 3)).toEqual([
      { role: "user", content: "今天所有店铺销售额是多少？" },
      { role: "assistant", content: "第一家店铺销售额最高。" },
    ]);
    expect(body.messages.at(-1)).toEqual(expect.objectContaining({ role: "user", content: expect.stringContaining('"shopId":"102"') }));
  });

  it("streams OpenAI-compatible completion deltas as they arrive", async () => {
    delete process.env.DEMO_MODE;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response([
      'data: {"choices":[{"delta":{"content":"实时"}}]}',
      'data: {"choices":[{"delta":{"content":"回答"}}]}',
      "data: [DONE]",
      "",
    ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const service = new ModelProviderService({ enabled: false } as never);
    const provider = await service.create({ name: "Stream", type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "sk-stream", defaultModel: "model-stream" });
    await service.assignProfile("default_chat_model", provider.id, "model-stream");
    const deltas: string[] = [];

    await expect(service.complete("今天销售怎么样？", { sales: 1 }, undefined, "default_chat_model", [], (delta) => deltas.push(delta)))
      .resolves.toEqual({ content: "实时回答", model: "Stream/model-stream" });

    expect(deltas).toEqual(["实时", "回答"]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({ stream: true }));
  });

  it("does not mix a fallback response into an already-started stream", async () => {
    delete process.env.DEMO_MODE;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response([
        'data: {"choices":[{"delta":{"content":"部分回答"}}]}',
        "data: not-json",
        "",
      ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "备用回答" } }] }), { status: 200 }));
    const service = new ModelProviderService({ enabled: false } as never);
    const primary = await service.create({ name: "Primary", type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "sk-primary", defaultModel: "primary-model" });
    const fallback = await service.create({ name: "Fallback", type: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey: "sk-fallback", defaultModel: "fallback-model" });
    await service.assignProfile("default_chat_model", primary.id, "primary-model");
    await service.assignProfile("fallback_model", fallback.id, "fallback-model");
    const deltas: string[] = [];

    await expect(service.complete("查询销售", {}, undefined, "default_chat_model", [], (delta) => deltas.push(delta)))
      .rejects.toThrow("MODEL_STREAM_INTERRUPTED");

    expect(deltas).toEqual(["部分回答"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not count a caller cancellation as a provider failure", async () => {
    delete process.env.DEMO_MODE;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const service = new ModelProviderService({ enabled: false } as never);
    const provider = await service.create({ name: "Cancelled", type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "sk-cancel", defaultModel: "model-cancel" });
    await service.assignProfile("default_chat_model", provider.id, "model-cancel");
    const controller = new AbortController();
    const completion = service.complete("停止", {}, controller.signal, "default_chat_model", [], () => undefined);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();

    await expect(completion).rejects.toThrow("MODEL_REQUEST_CANCELLED");
    expect((await service.list()).find((item) => item.id === provider.id)).toEqual(expect.objectContaining({ requestCount: 0, failureCount: 0 }));
  });

  it("routes each OpenClaw request through the current default profile and uses one fallback", async () => {
    delete process.env.DEMO_MODE;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("primary unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("data: {\"choices\":[{\"delta\":{\"content\":\"备用\"}}]}\n\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }))
      .mockResolvedValueOnce(new Response("data: {\"choices\":[{\"delta\":{\"content\":\"已切换\"}}]}\n\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }));
    const service = new ModelProviderService({ enabled: false } as never);
    const primary = await service.create({ name: "Primary", type: "openai-compatible", baseUrl: "https://api.openai.com/v1", apiKey: "sk-primary", defaultModel: "model-primary" });
    const fallback = await service.create({ name: "Fallback", type: "openai-compatible", baseUrl: "https://api.deepseek.com", apiKey: "sk-fallback", defaultModel: "model-fallback" });
    await service.assignProfile("default_chat_model", primary.id, "model-primary");
    await service.assignProfile("fallback_model", fallback.id, "model-fallback");
    const request = parseOpenClawCompletionRequest({ model: "default", messages: [{ role: "user", content: "昨日销售" }], stream: true });

    expect(await (await service.proxyOpenClawCompletion(request)).text()).toContain("备用");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({ model: "model-primary" }));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual(expect.objectContaining({ model: "model-fallback" }));
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe("Bearer sk-fallback");

    await service.assignProfile("default_chat_model", fallback.id, "model-new-default");
    expect(await (await service.proxyOpenClawCompletion(request)).text()).toContain("已切换");
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual(expect.objectContaining({ model: "model-new-default" }));
  });

  it("adapts an Anthropic default model without exposing its API key", async () => {
    delete process.env.DEMO_MODE;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "msg_1",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "经营摘要" }],
      usage: { input_tokens: 8, output_tokens: 4 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const service = new ModelProviderService({ enabled: false } as never);
    const provider = await service.create({ name: "Anthropic", type: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "anthropic-secret", defaultModel: "claude-test" });
    await service.assignProfile("default_chat_model", provider.id, "claude-test");
    const request = parseOpenClawCompletionRequest({ model: "default", messages: [{ role: "user", content: "查询销售" }], stream: true });

    const response = await service.proxyOpenClawCompletion(request);
    const body = await response.text();
    expect(fetchMock).toHaveBeenCalledWith("https://api.anthropic.com/v1/messages", expect.objectContaining({ redirect: "error" }));
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-api-key")).toBe("anthropic-secret");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(expect.objectContaining({ model: "claude-test", stream: false }));
    expect(body).toContain("经营摘要");
    expect(body).not.toContain("anthropic-secret");
  });
});

function persistedProvider(overrides: Record<string, unknown>) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Provider",
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyCipher: null,
    apiKeyIv: null,
    apiKeyTag: null,
    defaultModel: "gpt-test",
    active: true,
    lastTestedAt: null,
    lastTestStatus: null,
    requestCount: 0,
    failureCount: 0,
    lastUsedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
