import { z } from "zod";

export const pddSessionSchema = z.object({
  cookie: z.string().min(1).max(64_000),
  userAgent: z.string().min(1).max(1_000),
  sesId: z.string().max(1_000).optional(),
  expiresAt: z.string().datetime().optional(),
  proxy: z.object({ required: z.boolean(), endpoint: z.string().url().optional() }).strict().optional(),
}).strict();

export type PddSession = z.infer<typeof pddSessionSchema>;
export type PddTransport = (url: URL, init: RequestInit, session: PddSession) => Promise<Response>;

export interface PddClientOptions {
  baseUrl?: string;
  getSession: () => Promise<PddSession | null> | PddSession | null;
  transport?: PddTransport;
  timeoutMs?: number;
  hostAllowlist?: string[];
}

export interface PddRequest<T> {
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  schema: z.ZodType<T>;
  timeoutMs?: number;
}

export class PddApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 0) {
    super(message);
    this.name = "PddApiError";
  }
}

export class PddClient {
  private readonly baseUrl: URL;
  private readonly getSession: PddClientOptions["getSession"];
  private readonly transport: PddTransport | undefined;
  private readonly timeoutMs: number;

  constructor(options: PddClientOptions) {
    this.baseUrl = allowedBaseUrl(options.baseUrl ?? "https://mms.pinduoduo.com", options.hostAllowlist ?? []);
    this.getSession = options.getSession;
    this.transport = options.transport;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async request<T>(request: PddRequest<T>): Promise<T> {
    const sessionValue = await this.getSession();
    if (sessionValue === null) throw new PddApiError("PDD_SESSION_MISSING", "拼多多会话尚未准备", 401);
    const sessionResult = pddSessionSchema.safeParse(sessionValue);
    if (!sessionResult.success) throw new PddApiError("PDD_SESSION_INVALID", "拼多多会话格式无效", 401);
    const session = sessionResult.data;
    if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) throw new PddApiError("PDD_SESSION_EXPIRED", "拼多多会话已过期", 401);
    if (session.proxy?.required && !this.transport) throw new PddApiError("PDD_PROXY_TRANSPORT_REQUIRED", "当前店铺会话需要固定代理出口");
    const url = requestUrl(this.baseUrl, request.path, request.query);
    const method = request.method ?? "GET";
    if (method === "GET" && request.body !== undefined) throw new PddApiError("PDD_GET_BODY_NOT_ALLOWED", "GET 请求不能包含正文");
    const headers = safeHeaders(request.headers);
    headers.set("Accept", headers.get("Accept") ?? "application/json, text/plain, */*");
    headers.set("User-Agent", session.userAgent);
    headers.set("Cookie", session.cookie);
    headers.set("X-Requested-With", headers.get("X-Requested-With") ?? "XMLHttpRequest");
    if (request.body !== undefined) headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");

    const attempts = method === "GET" ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? this.timeoutMs);
      try {
        const init: RequestInit = {
          method,
          redirect: "error",
          signal: controller.signal,
          headers,
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        };
        const response = this.transport ? await this.transport(url, init, session) : await fetch(url, init);
        if (attempt < attempts && (response.status === 429 || response.status >= 500)) {
          await response.body?.cancel().catch(() => undefined);
          await delay(retryDelay(response.headers.get("retry-after"), attempt));
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new PddApiError(response.status === 401 || response.status === 403 ? "PDD_SESSION_INVALID" : "PDD_REQUEST_FAILED", `拼多多接口请求失败（HTTP ${response.status}）`, response.status);
        }
        const raw = await readJson(response);
        const parsed = request.schema.safeParse(raw);
        if (!parsed.success) throw new PddApiError("PDD_RESPONSE_INVALID", "拼多多接口响应结构不符合预期", response.status);
        return parsed.data;
      } catch (error) {
        if (error instanceof PddApiError) throw error;
        if (error instanceof Error && error.name === "AbortError") throw new PddApiError("PDD_TIMEOUT", "拼多多接口请求超时", 504);
        if (attempt < attempts) { await delay(retryDelay(null, attempt)); continue; }
        throw new PddApiError("PDD_NETWORK_ERROR", "拼多多接口网络错误", 502);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new PddApiError("PDD_REQUEST_FAILED", "拼多多接口请求失败", 502);
  }
}

function allowedBaseUrl(value: string, configuredHosts: string[]) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("PDD_BASE_URL_INVALID"); }
  const hosts = new Set(["mms.pinduoduo.com", "mobile.yangkeduo.com", ...configuredHosts.map((host) => host.trim().toLowerCase()).filter(Boolean)]);
  if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443")) throw new Error("PDD_BASE_URL_NOT_ALLOWED");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

function requestUrl(baseUrl: URL, path: string, query?: PddRequest<unknown>["query"]) {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.split("/").includes("..")) throw new PddApiError("PDD_PATH_INVALID", "拼多多请求路径无效");
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin) throw new PddApiError("PDD_PATH_INVALID", "拼多多请求路径无效");
  for (const [key, value] of Object.entries(query ?? {})) if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  return url;
}

function safeHeaders(values: Record<string, string> = {}) {
  const headers = new Headers();
  const forbidden = /^(authorization|cookie|host|proxy-authorization|forwarded|x-forwarded-|content-length|connection)$/i;
  for (const [name, value] of Object.entries(values)) {
    if (forbidden.test(name) || /[\r\n]/.test(name) || /[\r\n]/.test(value)) throw new PddApiError("PDD_HEADER_NOT_ALLOWED", "请求 Header 不允许覆盖敏感会话字段");
    headers.set(name, value);
  }
  return headers;
}

async function readJson(response: Response) {
  const maximumBytes = 5_000_000;
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new PddApiError("PDD_RESPONSE_TOO_LARGE", "拼多多接口响应超过大小限制", response.status);
  }
  if (!response.body) throw new PddApiError("PDD_RESPONSE_INVALID", "拼多多接口未返回有效 JSON", response.status);
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
        throw new PddApiError("PDD_RESPONSE_TOO_LARGE", "拼多多接口响应超过大小限制", response.status);
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
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { throw new PddApiError("PDD_RESPONSE_INVALID", "拼多多接口未返回有效 JSON", response.status); }
}

function retryDelay(retryAfter: string | null, attempt: number) {
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) return Math.min(Number(retryAfter) * 1_000, 10_000);
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.min(Math.max(retryAt - Date.now(), 0), 10_000);
  }
  return Math.min(250 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100), 2_000);
}

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
