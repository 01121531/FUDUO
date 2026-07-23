declare module "@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js" {
  export function sendMessageWeixin(params: {
    to: string;
    text: string;
    opts: { baseUrl: string; token: string; contextToken?: string; timeoutMs?: number; runId?: string };
  }): Promise<{ messageId: string }>;
}

declare module "@tencent-weixin/openclaw-weixin/dist/src/auth/login-qr.js" {
  export function startWeixinLoginWithQr(options: { accountId?: string; apiBaseUrl: string; force?: boolean; verbose?: boolean }): Promise<{ qrcodeUrl?: string; message: string; sessionKey: string }>;
  export function waitForWeixinLogin(options: { sessionKey: string; apiBaseUrl: string; timeoutMs?: number }): Promise<{ connected: boolean; alreadyConnected?: boolean; botToken?: string; accountId?: string; baseUrl?: string; userId?: string; message: string }>;
}

declare module "@tencent-weixin/openclaw-weixin/dist/src/auth/accounts.js" {
  export const DEFAULT_BASE_URL: string;
  export function listIndexedWeixinAccountIds(): string[];
  export function loadWeixinAccount(accountId: string): { token?: string; baseUrl?: string; userId?: string } | null;
  export function saveWeixinAccount(accountId: string, value: { token: string; baseUrl?: string; userId?: string }): void;
  export function registerWeixinAccountId(accountId: string): void;
  export function clearStaleAccountsForUserId(accountId: string, userId: string, clear?: (accountId: string) => void): void;
  export function triggerWeixinChannelReload(): Promise<void>;
}

declare module "@tencent-weixin/openclaw-weixin/dist/src/messaging/inbound.js" {
  export function clearContextTokensForAccount(accountId: string): void;
}

declare module "@tencent-weixin/openclaw-weixin/dist/src/api/api.js" {
  export function apiGetFetch(params: { baseUrl: string; endpoint: string; timeoutMs?: number; label: string }): Promise<string>;
  export function apiPostFetch(params: { baseUrl: string; endpoint: string; body: string; token?: string; timeoutMs?: number; label: string; abortSignal?: AbortSignal }): Promise<string>;
}
