import { randomUUID } from "node:crypto";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  DEFAULT_BASE_URL,
  clearStaleAccountsForUserId,
  listIndexedWeixinAccountIds,
  loadWeixinAccount,
  registerWeixinAccountId,
  saveWeixinAccount,
  triggerWeixinChannelReload,
} from "@tencent-weixin/openclaw-weixin/dist/src/auth/accounts.js";
import { clearContextTokensForAccount } from "@tencent-weixin/openclaw-weixin/dist/src/messaging/inbound.js";
import { WechatQrClient, type WechatQrProgress, type WechatQrWaitResult } from "./wechat-qr-client.js";

export type WechatLoginStatus = "IDLE" | "STARTING" | "PENDING" | "SCANNED" | "VERIFY_CODE_REQUIRED" | "COMMITTING" | "SUCCESS" | "FAILED" | "EXPIRED" | "CANCELLED";

export interface WechatLoginSnapshot {
  sessionId: string | null;
  status: WechatLoginStatus;
  qrDataUrl: string | null;
  accountId: string | null;
  accounts: string[];
  createdAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
  message: string;
  errorCode: string | null;
}

interface LoginDependencies {
  configured(): boolean;
  start(options: { accountId?: string; apiBaseUrl: string; force: boolean }): Promise<{ qrcodeUrl?: string; message: string; sessionKey: string }>;
  wait(options: {
    sessionKey: string;
    apiBaseUrl: string;
    timeoutMs: number;
    signal: AbortSignal;
    onProgress: (progress: WechatQrProgress) => void;
    getVerificationCode: (retry: boolean) => Promise<string>;
  }): Promise<WechatQrWaitResult>;
  listAccounts(): string[];
  loadAccount(accountId: string): { baseUrl?: string } | null;
  saveAccount(accountId: string, value: { token: string; baseUrl?: string; userId?: string }): void;
  registerAccount(accountId: string): void;
  clearStale(accountId: string, userId: string): void;
  reload(): Promise<void>;
}

const LOGIN_TTL_MS = 5 * 60_000;
const ACTIVE_STATUSES = new Set<WechatLoginStatus>(["STARTING", "PENDING", "SCANNED", "VERIFY_CODE_REQUIRED"]);

export class WechatLoginManager {
  private snapshot: WechatLoginSnapshot = idleSnapshot();
  private startInFlight: Promise<WechatLoginSnapshot> | null = null;
  private abortController: AbortController | null = null;
  private verificationWaiter: { sessionId: string; resolve: (code: string) => void; reject: (error: Error) => void } | null = null;

  constructor(private readonly dependencies: LoginDependencies = defaultDependencies) {}

  status(): WechatLoginSnapshot {
    if (ACTIVE_STATUSES.has(this.snapshot.status) && this.snapshot.expiresAt && Date.parse(this.snapshot.expiresAt) <= Date.now()) {
      this.abortController?.abort();
      this.rejectVerification("WECHAT_LOGIN_EXPIRED");
      this.snapshot = { ...this.snapshot, status: "EXPIRED", qrDataUrl: null, updatedAt: new Date().toISOString(), message: "二维码已过期，请重新生成", errorCode: "WECHAT_LOGIN_EXPIRED" };
    }
    return { ...this.snapshot, accounts: [...this.dependencies.listAccounts()] };
  }

  async start(accountId?: string): Promise<WechatLoginSnapshot> {
    if (!this.dependencies.configured()) throw new Error("OPENCLAW_NOT_CONFIGURED");
    if (this.startInFlight) return this.startInFlight;
    const current = this.status();
    if (ACTIVE_STATUSES.has(current.status)) return current;

    const operation = this.beginStart(accountId);
    this.startInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.startInFlight === operation) this.startInFlight = null;
    }
  }

  cancel(): WechatLoginSnapshot {
    if (ACTIVE_STATUSES.has(this.snapshot.status)) {
      this.abortController?.abort();
      this.rejectVerification("WECHAT_LOGIN_CANCELLED");
      this.snapshot = { ...this.snapshot, status: "CANCELLED", qrDataUrl: null, updatedAt: new Date().toISOString(), message: "登录已取消", errorCode: null };
    }
    return this.status();
  }

  submitVerificationCode(code: string): WechatLoginSnapshot {
    const normalized = code.trim();
    if (!/^\d{4,8}$/.test(normalized)) throw new Error("WECHAT_VERIFY_CODE_INVALID");
    const waiter = this.verificationWaiter;
    if (!waiter || waiter.sessionId !== this.snapshot.sessionId || this.snapshot.status !== "VERIFY_CODE_REQUIRED") {
      throw new Error("WECHAT_VERIFY_CODE_NOT_REQUIRED");
    }
    this.verificationWaiter = null;
    this.snapshot = { ...this.snapshot, status: "SCANNED", updatedAt: new Date().toISOString(), message: "验证码已提交，正在验证", errorCode: null };
    waiter.resolve(normalized);
    return this.status();
  }

  private async beginStart(accountId?: string) {
    const normalizedRequested = accountId?.trim() || undefined;
    const apiBaseUrl = normalizedRequested ? this.dependencies.loadAccount(normalizedRequested)?.baseUrl?.trim() || DEFAULT_BASE_URL : DEFAULT_BASE_URL;
    const sessionId = randomUUID();
    const now = new Date();
    this.snapshot = {
      sessionId,
      status: "STARTING",
      qrDataUrl: null,
      accountId: normalizedRequested ?? null,
      accounts: this.dependencies.listAccounts(),
      createdAt: now.toISOString(),
      expiresAt: null,
      updatedAt: now.toISOString(),
      message: "正在生成微信登录二维码",
      errorCode: null,
    };

    try {
      const started = await this.dependencies.start({ ...(normalizedRequested ? { accountId: normalizedRequested } : {}), apiBaseUrl, force: true });
      if (!started.qrcodeUrl) throw new Error("WECHAT_LOGIN_QR_UNAVAILABLE");
      if (this.snapshot.sessionId !== sessionId || this.snapshot.status !== "STARTING") return this.status();
      this.abortController = new AbortController();
      const readyAt = new Date();
      this.snapshot = {
        ...this.snapshot,
        status: "PENDING",
        qrDataUrl: started.qrcodeUrl,
        expiresAt: new Date(readyAt.getTime() + LOGIN_TTL_MS).toISOString(),
        updatedAt: readyAt.toISOString(),
        message: "请使用微信扫描二维码并在手机上确认",
      };
      void this.wait(sessionId, started.sessionKey, apiBaseUrl, this.abortController.signal);
      return this.status();
    } catch (error) {
      if (this.snapshot.sessionId === sessionId && this.snapshot.status === "STARTING") {
        const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "WECHAT_LOGIN_START_FAILED";
        this.snapshot = { ...this.snapshot, status: "FAILED", qrDataUrl: null, updatedAt: new Date().toISOString(), message: "微信登录二维码生成失败", errorCode: code };
      }
      throw error;
    }
  }

  private async wait(sessionId: string, sessionKey: string, apiBaseUrl: string, signal: AbortSignal) {
    try {
      const result = await this.dependencies.wait({
        sessionKey,
        apiBaseUrl,
        timeoutMs: LOGIN_TTL_MS,
        signal,
        onProgress: (progress) => this.updateProgress(sessionId, progress),
        getVerificationCode: (retry) => this.waitForVerificationCode(sessionId, retry),
      });
      if (this.snapshot.sessionId !== sessionId || !ACTIVE_STATUSES.has(this.snapshot.status)) return;
      if (result.connected && result.botToken && result.accountId) {
        const accountId = normalizeAccountId(result.accountId);
        this.snapshot = { ...this.snapshot, status: "COMMITTING", qrDataUrl: null, accountId, updatedAt: new Date().toISOString(), message: "正在保存微信账号", errorCode: null };
        this.dependencies.saveAccount(accountId, { token: result.botToken, ...(result.baseUrl ? { baseUrl: result.baseUrl } : {}), ...(result.userId ? { userId: result.userId } : {}) });
        this.dependencies.registerAccount(accountId);
        if (result.userId) this.dependencies.clearStale(accountId, result.userId);
        await this.dependencies.reload();
        if (this.snapshot.sessionId !== sessionId || this.snapshot.status !== "COMMITTING") return;
        this.snapshot = { ...this.snapshot, status: "SUCCESS", accountId, accounts: this.dependencies.listAccounts(), updatedAt: new Date().toISOString(), message: "微信账号登录成功", errorCode: null };
        return;
      }
      const expired = /过期|超时|expired|timeout/i.test(result.message);
      this.snapshot = { ...this.snapshot, status: result.alreadyConnected ? "SUCCESS" : expired ? "EXPIRED" : "FAILED", qrDataUrl: null, updatedAt: new Date().toISOString(), message: result.alreadyConnected ? "微信账号已连接" : expired ? "二维码已过期，请重新生成" : "微信账号登录失败", errorCode: result.alreadyConnected ? null : expired ? "WECHAT_LOGIN_EXPIRED" : "WECHAT_LOGIN_FAILED" };
    } catch {
      if (this.snapshot.sessionId !== sessionId || !ACTIVE_STATUSES.has(this.snapshot.status)) return;
      this.snapshot = { ...this.snapshot, status: "FAILED", qrDataUrl: null, updatedAt: new Date().toISOString(), message: "微信账号登录失败", errorCode: "WECHAT_LOGIN_FAILED" };
    } finally {
      if (this.snapshot.sessionId === sessionId) {
        this.abortController = null;
        this.rejectVerification("WECHAT_LOGIN_ENDED");
      }
    }
  }

  private updateProgress(sessionId: string, progress: WechatQrProgress) {
    if (this.snapshot.sessionId !== sessionId || !ACTIVE_STATUSES.has(this.snapshot.status)) return;
    const now = new Date();
    if (progress.type === "QR_REFRESHED") {
      this.snapshot = { ...this.snapshot, status: "PENDING", qrDataUrl: progress.qrContent, expiresAt: new Date(now.getTime() + LOGIN_TTL_MS).toISOString(), updatedAt: now.toISOString(), message: "二维码已更新，请重新扫描", errorCode: null };
    } else if (progress.type === "SCANNED") {
      this.snapshot = { ...this.snapshot, status: "SCANNED", updatedAt: now.toISOString(), message: "已扫码，请在手机上确认", errorCode: null };
    } else {
      this.snapshot = { ...this.snapshot, status: "VERIFY_CODE_REQUIRED", updatedAt: now.toISOString(), message: progress.retry ? "验证码不正确，请重新输入手机显示的数字" : "请输入手机微信显示的数字验证码", errorCode: progress.retry ? "WECHAT_VERIFY_CODE_REJECTED" : null };
    }
  }

  private waitForVerificationCode(sessionId: string, retry: boolean) {
    this.updateProgress(sessionId, { type: "VERIFY_CODE_REQUIRED", retry });
    return new Promise<string>((resolve, reject) => {
      this.rejectVerification("WECHAT_VERIFY_CODE_REPLACED");
      this.verificationWaiter = { sessionId, resolve, reject };
    });
  }

  private rejectVerification(code: string) {
    const waiter = this.verificationWaiter;
    this.verificationWaiter = null;
    waiter?.reject(new Error(code));
  }
}

const qrClient = new WechatQrClient();
const defaultDependencies: LoginDependencies = {
  configured: () => Boolean(process.env.OPENCLAW_STATE_DIR),
  start: () => qrClient.start(),
  wait: (options) => qrClient.wait(options),
  listAccounts: listIndexedWeixinAccountIds,
  loadAccount: loadWeixinAccount,
  saveAccount: saveWeixinAccount,
  registerAccount: registerWeixinAccountId,
  clearStale: (accountId, userId) => clearStaleAccountsForUserId(accountId, userId, clearContextTokensForAccount),
  reload: triggerWeixinChannelReload,
};

function idleSnapshot(): WechatLoginSnapshot {
  return { sessionId: null, status: "IDLE", qrDataUrl: null, accountId: null, accounts: [], createdAt: null, expiresAt: null, updatedAt: new Date().toISOString(), message: "尚未开始微信登录", errorCode: null };
}
