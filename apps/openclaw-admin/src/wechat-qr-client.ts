import { randomUUID } from "node:crypto";
import { apiGetFetch, apiPostFetch } from "@tencent-weixin/openclaw-weixin/dist/src/api/api.js";
import { listIndexedWeixinAccountIds, loadWeixinAccount } from "@tencent-weixin/openclaw-weixin/dist/src/auth/accounts.js";

const API_BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESHES = 3;

interface QrSession {
  qrcode: string;
  apiBaseUrl: string;
  refreshCount: number;
}

interface QrResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface StatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | "verify_code_blocked" | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export type WechatQrProgress =
  | { type: "SCANNED" }
  | { type: "VERIFY_CODE_REQUIRED"; retry: boolean }
  | { type: "QR_REFRESHED"; qrContent: string };

export interface WechatQrWaitResult {
  connected: boolean;
  alreadyConnected?: boolean;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
  message: string;
}

export class WechatQrClient {
  private readonly sessions = new Map<string, QrSession>();

  async start(): Promise<{ qrcodeUrl?: string; message: string; sessionKey: string }> {
    const sessionKey = randomUUID();
    const qr = await this.fetchQrCode();
    this.sessions.set(sessionKey, { qrcode: qr.qrcode, apiBaseUrl: API_BASE_URL, refreshCount: 0 });
    return { qrcodeUrl: qr.qrcode_img_content, message: "请使用微信扫描二维码", sessionKey };
  }

  async wait(options: {
    sessionKey: string;
    timeoutMs: number;
    signal: AbortSignal;
    onProgress: (progress: WechatQrProgress) => void;
    getVerificationCode: (retry: boolean) => Promise<string>;
  }): Promise<WechatQrWaitResult> {
    const session = this.sessions.get(options.sessionKey);
    if (!session) return { connected: false, message: "二维码会话不存在或已过期" };
    const deadline = Date.now() + Math.max(options.timeoutMs, 1_000);
    let verifyCode: string | undefined;

    try {
      while (Date.now() < deadline && !options.signal.aborted) {
        const status = await this.poll(session, verifyCode);
        if (options.signal.aborted) break;
        switch (status.status) {
          case "wait":
            break;
          case "scaned":
            verifyCode = undefined;
            options.onProgress({ type: "SCANNED" });
            break;
          case "need_verifycode":
            options.onProgress({ type: "VERIFY_CODE_REQUIRED", retry: Boolean(verifyCode) });
            verifyCode = await options.getVerificationCode(Boolean(verifyCode));
            continue;
          case "verify_code_blocked":
            verifyCode = undefined;
            if (!await this.refresh(session, options.onProgress)) {
              return { connected: false, message: "验证码错误次数过多，请稍后重试" };
            }
            break;
          case "expired":
            verifyCode = undefined;
            if (!await this.refresh(session, options.onProgress)) {
              return { connected: false, message: "二维码已过期，请重新生成" };
            }
            break;
          case "scaned_but_redirect":
            options.onProgress({ type: "SCANNED" });
            if (status.redirect_host && /^[a-z0-9.-]+$/i.test(status.redirect_host)) {
              session.apiBaseUrl = `https://${status.redirect_host}`;
            }
            break;
          case "binded_redirect":
            return { connected: false, alreadyConnected: true, message: "微信账号已连接" };
          case "confirmed":
            if (!status.ilink_bot_id || !status.bot_token) {
              return { connected: false, message: "微信确认响应缺少账号凭证" };
            }
            return {
              connected: true,
              botToken: status.bot_token,
              accountId: status.ilink_bot_id,
              ...(status.baseurl ? { baseUrl: status.baseurl } : {}),
              ...(status.ilink_user_id ? { userId: status.ilink_user_id } : {}),
              message: "微信账号登录成功",
            };
        }
        await delay(1_000, options.signal);
      }
      return { connected: false, message: options.signal.aborted ? "微信登录已取消" : "二维码已过期，请重新生成" };
    } finally {
      this.sessions.delete(options.sessionKey);
    }
  }

  private async fetchQrCode(): Promise<QrResponse> {
    const localTokenList = listIndexedWeixinAccountIds()
      .slice(-10)
      .reverse()
      .map((accountId) => loadWeixinAccount(accountId)?.token?.trim())
      .filter((token): token is string => Boolean(token));
    const raw = await apiPostFetch({
      baseUrl: API_BASE_URL,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
      body: JSON.stringify({ local_token_list: localTokenList }),
      timeoutMs: 30_000,
      label: "wechatQrStart",
    });
    const parsed = JSON.parse(raw) as Partial<QrResponse>;
    if (!parsed.qrcode || !parsed.qrcode_img_content) throw new Error("WECHAT_LOGIN_QR_UNAVAILABLE");
    return parsed as QrResponse;
  }

  private async poll(session: QrSession, verifyCode?: string): Promise<StatusResponse> {
    const query = new URLSearchParams({ qrcode: session.qrcode });
    if (verifyCode) query.set("verify_code", verifyCode);
    try {
      const raw = await apiGetFetch({
        baseUrl: session.apiBaseUrl,
        endpoint: `ilink/bot/get_qrcode_status?${query.toString()}`,
        timeoutMs: POLL_TIMEOUT_MS,
        label: "wechatQrStatus",
      });
      return JSON.parse(raw) as StatusResponse;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return { status: "wait" };
      throw error;
    }
  }

  private async refresh(session: QrSession, onProgress: (progress: WechatQrProgress) => void) {
    session.refreshCount += 1;
    if (session.refreshCount >= MAX_QR_REFRESHES) return false;
    const qr = await this.fetchQrCode();
    session.qrcode = qr.qrcode;
    session.apiBaseUrl = API_BASE_URL;
    onProgress({ type: "QR_REFRESHED", qrContent: qr.qrcode_img_content });
    return true;
  }
}

function delay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
