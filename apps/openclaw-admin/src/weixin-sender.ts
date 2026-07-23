import { readFile } from "node:fs/promises";
import path from "node:path";
import { sendMessageWeixin } from "@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js";

interface AccountData { token?: unknown; baseUrl?: unknown }

export class WeixinSender {
  private readonly stateDir: string;

  constructor(
    stateDir = process.env.OPENCLAW_STATE_DIR,
    private readonly sendImpl: typeof sendMessageWeixin = sendMessageWeixin,
  ) {
    if (!stateDir) throw new Error("OPENCLAW_STATE_DIR_REQUIRED");
    this.stateDir = path.resolve(stateDir);
  }

  async send(externalUserId: string, text: string, idempotencyKey?: string) {
    const recipient = externalUserId.trim();
    if (!recipient.endsWith("@im.wechat") || recipient.length > 256) throw new Error("WECHAT_RECIPIENT_INVALID");
    if (!text.trim() || text.length > 4_000) throw new Error("WECHAT_MESSAGE_INVALID");
    if (idempotencyKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) throw new Error("WECHAT_IDEMPOTENCY_KEY_INVALID");
    const accountIds = await this.readAccountIds();
    if (!accountIds.length) throw new Error("WECHAT_ACCOUNT_NOT_CONFIGURED");
    const matches: Array<{ accountId: string; contextToken: string }> = [];
    for (const accountId of accountIds) {
      const tokens = await this.readJson<Record<string, unknown>>(this.accountFile(accountId, ".context-tokens.json"), {});
      const contextToken = tokens[recipient];
      if (typeof contextToken === "string" && contextToken) matches.push({ accountId, contextToken });
    }
    if (matches.length > 1 || (matches.length === 0 && accountIds.length > 1)) throw new Error("WECHAT_ACCOUNT_AMBIGUOUS");
    const selected = matches[0] ?? { accountId: accountIds[0]!, contextToken: undefined };
    const account = await this.readJson<AccountData>(this.accountFile(selected.accountId, ".json"), {});
    const token = typeof account.token === "string" ? account.token.trim() : "";
    if (!token) throw new Error("WECHAT_ACCOUNT_NOT_CONFIGURED");
    const baseUrl = validateBaseUrl(typeof account.baseUrl === "string" ? account.baseUrl : "https://ilinkai.weixin.qq.com");
    try {
      return await this.sendImpl({ to: recipient, text, opts: { baseUrl, token, ...(selected.contextToken ? { contextToken: selected.contextToken } : {}), ...(idempotencyKey ? { runId: idempotencyKey } : {}), timeoutMs: 15_000 } });
    } catch {
      throw new Error("WECHAT_DELIVERY_FAILED");
    }
  }

  private async readAccountIds() {
    const file = path.join(this.stateDir, "openclaw-weixin", "accounts.json");
    const ids = await this.readJson<unknown>(file, []);
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids.filter((value): value is string => typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value)))];
  }

  private accountFile(accountId: string, suffix: string) {
    return path.join(this.stateDir, "openclaw-weixin", "accounts", `${accountId}${suffix}`);
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      const raw = await readFile(file, "utf8");
      if (raw.length > 128 * 1024) throw new Error("OPENCLAW_STATE_FILE_TOO_LARGE");
      return JSON.parse(raw) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
  }
}

function validateBaseUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.hostname !== "ilinkai.weixin.qq.com") throw new Error("WECHAT_BASE_URL_INVALID");
  return parsed.origin;
}
