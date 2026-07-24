import { z } from "zod";
import {
  envelopeSchema,
  meSchema,
  merchantBackendPrepareSchema,
  opsAfterSalesPageSchema,
  opsOrderPageSchema,
  qrLoginSchema,
  qrLoginPollSchema,
  refreshSessionSchema,
  salesLiveSchema,
  visibleShopPageSchema,
  type MerchantBackendPrepare,
  type OpsAfterSalesPage,
  type OpsOrderPage,
  type QrLogin,
  type QrLoginPoll,
  type SalesLive,
  type VisibleShopPage,
} from "./schemas.js";

export * from "./schemas.js";

export class FuduoApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly traceId?: string,
  ) {
    super(message);
    this.name = "FuduoApiError";
  }
}

export interface FuduoClientOptions {
  baseUrl?: string;
  getAccessToken?: () => Promise<string | null> | string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class FuduoClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: NonNullable<FuduoClientOptions["getAccessToken"]>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: FuduoClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.FUDUO_API_BASE_URL ?? "https://erp.fuduo8888.com").replace(/\/+$/, "");
    assertAllowedBaseUrl(this.baseUrl);
    this.getAccessToken = options.getAccessToken ?? (() => null);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 5_000_000;
  }

  async getQrLogin(): Promise<QrLogin> {
    return this.request("/api/v1/auth/wecom/qr-url", qrLoginSchema, { auth: false });
  }

  async pollQrLogin(state: string): Promise<QrLoginPoll> {
    const query = new URLSearchParams({ state });
    return this.request(`/api/v1/auth/wecom/poll?${query}`, qrLoginPollSchema, { auth: false });
  }

  async refreshSession(currentToken?: string): Promise<string> {
    const token = currentToken ?? (await this.getAccessToken());
    if (!token) throw new FuduoApiError("ERP_TOKEN_MISSING", "富多授权尚未配置", 401);
    const data = await this.request<z.infer<typeof refreshSessionSchema>>(
      "/api/v1/auth/session/refresh",
      refreshSessionSchema,
      {
      method: "POST",
      token,
      body: {},
      },
    );
    return data.accessToken;
  }

  async getMe(): Promise<z.infer<typeof meSchema>> {
    return this.request("/api/v1/iam/me", meSchema);
  }

  async listVisibleShops(page = 1, size = 100): Promise<VisibleShopPage> {
    const query = new URLSearchParams({ page: String(page), size: String(size), enrichMode: "FULL" });
    return this.request(`/api/v1/shops/visible/page?${query}`, visibleShopPageSchema);
  }

  async getSalesLive(shopId: number, tradeDate: string): Promise<SalesLive> {
    const query = new URLSearchParams({ tradeDate });
    return this.request(`/api/v1/shops/${shopId}/sales-live?${query}`, salesLiveSchema, {
      timeoutMs: 120_000,
    });
  }

  async listOrders(shopId: number, startAt: string, endAt: string, page = 1, size = 100): Promise<OpsOrderPage> {
    return this.request("/api/v1/ops/orders/list", opsOrderPageSchema, {
      method: "POST",
      timeoutMs: 30_000,
      retryTransient: true,
      body: opsListBody(shopId, startAt, endAt, page, size),
    });
  }

  async listAfterSales(shopId: number, startAt: string, endAt: string, page = 1, size = 100): Promise<OpsAfterSalesPage> {
    return this.request("/api/v1/ops/aftersales/list", opsAfterSalesPageSchema, {
      method: "POST",
      timeoutMs: 30_000,
      retryTransient: true,
      body: opsListBody(shopId, startAt, endAt, page, size),
    });
  }

  async prepareMerchantBackend(
    accountId: number,
    options: { probe?: boolean; repairProfile?: boolean; forceFreshLogin?: boolean } = {},
  ): Promise<MerchantBackendPrepare> {
    return this.request(
      `/api/v1/shop-accounts/${accountId}/merchant-backend-prepare`,
      merchantBackendPrepareSchema,
      {
        method: "POST",
        timeoutMs: 120_000,
        body: { probe: true, repairProfile: true, ...options },
      },
    );
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
      method?: "GET" | "POST";
      body?: unknown;
      auth?: boolean;
      token?: string;
      timeoutMs?: number;
      retryTransient?: boolean;
    } = {},
  ): Promise<T> {
    const token = options.token ?? (options.auth === false ? null : await this.getAccessToken());
    if (options.auth !== false && !token) {
      throw new FuduoApiError("ERP_TOKEN_MISSING", "富多授权尚未配置", 401);
    }

    const method = options.method ?? "GET";
    const attempts = method === "GET" || options.retryTransient === true ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Client": "desktop",
            "X-Client-Type": "DESKTOP",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });

        if (attempt < attempts && (response.status === 429 || response.status >= 500)) {
          await response.body?.cancel().catch(() => undefined);
          await delay(retryDelay(response.headers.get("retry-after"), attempt));
          continue;
        }
        const raw = await readJson(response, this.maxResponseBytes);
        const envelope = envelopeSchema(schema).safeParse(raw);
        if (!envelope.success) {
          throw new FuduoApiError(
            "ERP_RESPONSE_INVALID",
            "富多接口响应结构不符合预期",
            response.status,
          );
        }
        if (!response.ok || !envelope.data.success || envelope.data.data === undefined) {
          throw new FuduoApiError(
            envelope.data.code ?? "ERP_REQUEST_FAILED",
            envelope.data.message ?? `富多接口请求失败（HTTP ${response.status}）`,
            response.status,
            envelope.data.traceId ?? undefined,
          );
        }
        return envelope.data.data;
      } catch (error) {
        if (error instanceof FuduoApiError) throw error;
        if (attempt < attempts && !(error instanceof Error && error.name === "AbortError")) {
          await delay(retryDelay(null, attempt));
          continue;
        }
        if (error instanceof Error && error.name === "AbortError") {
          throw new FuduoApiError("ERP_TIMEOUT", "富多接口请求超时", 504);
        }
        throw new FuduoApiError("ERP_NETWORK_ERROR", "富多接口网络错误", 502);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new FuduoApiError("ERP_REQUEST_FAILED", "富多接口请求失败", 502);
  }
}

function assertAllowedBaseUrl(value: string) {
  const url = new URL(value);
  const configured = (process.env.FUDUO_API_HOST_ALLOWLIST ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  const allowed = new Set(["erp.fuduo8888.com", ...configured]);
  if (url.protocol !== "https:" || !allowed.has(url.hostname) || url.username || url.password) {
    throw new Error("FUDUO_API_BASE_URL is not an allowed HTTPS endpoint");
  }
}

function opsListBody(shopId: number, startAt: string, endAt: string, page: number, size: number) {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || !Number.isInteger(page) || page <= 0 || !Number.isInteger(size) || size <= 0 || size > 500 || !Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new FuduoApiError("ERP_REQUEST_INVALID", "富多经营列表请求参数无效", 400);
  }
  return {
    platformCode: "pinduoduo",
    businessShopId: shopId,
    startAt: new Date(start).toISOString(),
    endAt: new Date(end).toISOString(),
    page,
    size,
  };
}

function retryDelay(retryAfter: string | null, attempt: number) {
  if (retryAfter && /^\d+$/.test(retryAfter)) return Math.min(Number(retryAfter) * 1_000, 10_000);
  return Math.min(250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100), 2_000);
}

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function readJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new FuduoApiError("ERP_RESPONSE_TOO_LARGE", "富多接口响应超过大小限制", response.status);
  }
  if (!response.body) {
    throw new FuduoApiError("ERP_RESPONSE_INVALID", "富多接口未返回有效 JSON", response.status);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new FuduoApiError("ERP_RESPONSE_TOO_LARGE", "富多接口响应超过大小限制", response.status);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new FuduoApiError("ERP_RESPONSE_INVALID", "富多接口未返回有效 JSON", response.status);
  }
}
