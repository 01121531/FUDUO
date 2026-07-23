import { Injectable } from "@nestjs/common";

export interface OpenClawPairingState {
  pending: Array<{ id: string; code: string; createdAt: string; lastSeenAt: string; meta: Record<string, string> }>;
  approved: string[];
}

@Injectable()
export class OpenClawAdminService {
  private readonly client: OpenClawAdminClient | null;

  constructor() {
    const url = process.env.OPENCLAW_ADMIN_URL;
    const token = process.env.OPENCLAW_ADMIN_TOKEN;
    this.client = url && token ? new OpenClawAdminClient(url, token) : null;
  }

  get configured() { return this.client !== null; }
  list() { return this.requireClient().list(); }
  approve(code: string) { return this.requireClient().approve(code); }
  revoke(externalUserId: string) { return this.requireClient().revoke(externalUserId); }
  send(externalUserId: string, text: string, idempotencyKey?: string) { return this.requireClient().send(externalUserId, text, idempotencyKey); }
  loginStatus() { return this.requireClient().loginStatus(); }
  loginStart(accountId?: string) { return this.requireClient().loginStart(accountId); }
  loginCancel() { return this.requireClient().loginCancel(); }
  loginVerify(code: string) { return this.requireClient().loginVerify(code); }

  private requireClient() {
    if (!this.client) throw new Error("OPENCLAW_ADMIN_NOT_CONFIGURED");
    return this.client;
  }
}

export class OpenClawAdminClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const parsed = new URL(baseUrl);
    const allowedHosts = new Set(["openclaw-admin", "127.0.0.1", "localhost"]);
    if (!["http:", "https:"].includes(parsed.protocol) || !allowedHosts.has(parsed.hostname)) throw new Error("OPENCLAW_ADMIN_URL_INVALID");
    if (token.length < 32) throw new Error("OPENCLAW_ADMIN_TOKEN_INVALID");
    this.baseUrl = parsed.toString().replace(/\/+$/, "");
  }

  list() { return this.request<OpenClawPairingState>("/pairings", "GET"); }
  approve(code: string) { return this.request<{ externalUserId: string; meta: Record<string, string> }>("/pairings/approve", "POST", { code }); }
  revoke(externalUserId: string) { return this.request<{ externalUserId: string; revoked: boolean }>("/pairings/revoke", "POST", { externalUserId }); }
  send(externalUserId: string, text: string, idempotencyKey?: string) { return this.request<{ messageId: string }>("/messages/send", "POST", { externalUserId, text, ...(idempotencyKey ? { idempotencyKey } : {}) }); }
  loginStatus() { return this.request<WechatLoginState>("/login/status", "GET"); }
  loginStart(accountId?: string) { return this.request<WechatLoginState>("/login/start", "POST", accountId ? { accountId } : undefined, 45_000); }
  loginCancel() { return this.request<WechatLoginState>("/login/cancel", "POST"); }
  loginVerify(code: string) { return this.request<WechatLoginState>("/login/verify", "POST", { code }); }

  private async request<T>(path: string, method: "GET" | "POST", body?: Record<string, string>, timeoutMs = 5_000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "X-Internal-Service-Token": this.token,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const payload = await response.json() as T & { error?: { code?: string } };
      if (!response.ok) throw new Error(payload.error?.code ?? "OPENCLAW_ADMIN_REQUEST_FAILED");
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface WechatLoginState {
  sessionId: string | null;
  status: "IDLE" | "STARTING" | "PENDING" | "SCANNED" | "VERIFY_CODE_REQUIRED" | "COMMITTING" | "SUCCESS" | "FAILED" | "EXPIRED" | "CANCELLED";
  qrDataUrl: string | null;
  accountId: string | null;
  accounts: string[];
  createdAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
  message: string;
  errorCode: string | null;
}
