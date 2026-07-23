export interface ToolClientConfig {
  apiBaseUrl: string;
  serviceToken: string | EnvironmentSecretRef;
}

export interface EnvironmentSecretRef {
  source: "env";
  provider?: string;
  id: string;
}

export interface ToolInvocationIdentity {
  channel: string;
  accountId: string;
  externalMessageId: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string; recovery?: string };
}

export class FuduoToolClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string;

  constructor(
    private readonly config: ToolClientConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const parsed = new URL(config.apiBaseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("apiBaseUrl must use HTTP or HTTPS");
    this.baseUrl = parsed.toString().replace(/\/+$/, "");
    this.serviceToken = resolveServiceToken(config.serviceToken);
    if (this.serviceToken.length < 32) throw new Error("serviceToken must contain at least 32 characters");
  }

  async invoke<T>(name: string, params: Record<string, unknown>, signal?: AbortSignal, channelUserId?: string, invocation?: ToolInvocationIdentity): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/tools/${encodeURIComponent(name)}`, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Internal-Service-Token": this.serviceToken,
          ...(channelUserId ? { "X-Channel-User-Id": channelUserId } : {}),
          ...(invocation ? {
            "X-Channel-Id": invocation.channel,
            "X-Channel-Account-Id": invocation.accountId,
            "X-Channel-Message-Id": invocation.externalMessageId,
          } : {}),
        },
        body: JSON.stringify(params),
      });
      const payload = await response.json() as ApiEnvelope<T>;
      if (!response.ok || !payload.success || payload.data === undefined) {
        throw new Error(payload.error?.message ?? `富多业务工具调用失败（${response.status}）`);
      }
      return payload.data;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}

function resolveServiceToken(value: ToolClientConfig["serviceToken"]): string {
  if (typeof value === "string") return value;
  if (value.source !== "env" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(value.id)) {
    throw new Error("serviceToken environment reference is invalid");
  }
  const resolved = process.env[value.id];
  if (!resolved) throw new Error(`serviceToken environment variable ${value.id} is not available`);
  return resolved;
}
