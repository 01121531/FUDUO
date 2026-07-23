import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Inject, Injectable, Optional, type MessageEvent, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { Observable, ReplaySubject } from "rxjs";
import { FuduoClient, type QrLoginPoll } from "@fuduo/fuduo-sdk";
import { CredentialService } from "../credentials/credential.service.js";
import { DatabaseService } from "../database/database.service.js";

type QrStatus =
  | "CREATED"
  | "WAITING_SCAN"
  | "SCANNED"
  | "VERIFYING"
  | "SUCCESS"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED";

export interface PublicQrSession {
  id: string;
  status: QrStatus;
  qrImage: string | null;
  expiresAt: string;
  accountName: string | null;
  shopCount: number | null;
  error: { code: string; message: string; recovery: string } | null;
}

interface InternalQrSession extends PublicQrSession {
  ownerId: string;
  loginUrl: string | null;
  qrState: string | null;
  events: ReplaySubject<MessageEvent>;
  context: BrowserContext | null;
  page: Page | null;
  terminal: boolean;
  tokenAccepted: boolean;
  expiryTimer: NodeJS.Timeout | null;
  tokenPoll: NodeJS.Timeout | null;
  authPoll: NodeJS.Timeout | null;
  authPollBusy: boolean;
}

const TERMINAL_STATUSES = new Set<QrStatus>(["SUCCESS", "FAILED", "EXPIRED", "CANCELLED"]);

@Injectable()
export class QrSessionService implements OnModuleInit, OnApplicationShutdown {
  private readonly sessions = new Map<string, InternalQrSession>();
  private readonly fuduo = new FuduoClient();
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private sessionMutation = Promise.resolve();
  private activeSessionId: string | null = null;

  constructor(
    @Inject(CredentialService) private readonly credentials: CredentialService,
    @Optional() @Inject(DatabaseService) private readonly database?: DatabaseService,
  ) {}

  async onModuleInit() {
    if (!this.database?.enabled) return;
    const now = new Date();
    const orphaned = {
      status: "FAILED",
      errorCode: "AUTH_BROWSER_SESSION_INTERRUPTED",
      errorMessage: "云端登录会话因服务重启而中断",
      errorRecovery: "请生成新二维码后重新扫码",
      finishedAt: now,
    };
    await this.database.prisma.loginSession.updateMany({
      where: { status: { in: ["CREATED", "WAITING_SCAN", "SCANNED", "VERIFYING"] } },
      data: orphaned,
    });
    await this.database.prisma.loginSession.deleteMany({
      where: { updatedAt: { lt: new Date(now.getTime() - 7 * 24 * 60 * 60_000) } },
    });
    const recoverable = await this.database.prisma.loginSession.findMany({
      where: { updatedAt: { gte: new Date(now.getTime() - 10 * 60_000) } },
      orderBy: { updatedAt: "desc" },
    });
    for (const stored of recoverable) {
      const events = new ReplaySubject<MessageEvent>(1);
      const session: InternalQrSession = {
        id: stored.id,
        ownerId: stored.ownerId,
        status: stored.status as QrStatus,
        qrImage: null,
        expiresAt: stored.expiresAt.toISOString(),
        accountName: stored.accountName,
        shopCount: stored.shopCount,
        error: stored.errorCode && stored.errorMessage && stored.errorRecovery
          ? { code: stored.errorCode, message: stored.errorMessage, recovery: stored.errorRecovery }
          : null,
        loginUrl: null,
        qrState: null,
        events,
        context: null,
        page: null,
        terminal: true,
        tokenAccepted: false,
        expiryTimer: null,
        tokenPoll: null,
        authPoll: null,
        authPollBusy: false,
      };
      this.sessions.set(session.id, session);
      this.emit(session);
      events.complete();
      const removeTimer = setTimeout(
        () => this.sessions.delete(session.id),
        Math.max(1, stored.updatedAt.getTime() + 10 * 60_000 - Date.now()),
      );
      removeTimer.unref();
    }
  }

  async create(ownerId = "demo-user"): Promise<PublicQrSession> {
    const session = await this.withSessionMutation(async () => {
      // ErpCredential is a singleton. A second administrator/session must not
      // race the first one and overwrite the global account after it was replaced.
      for (const existing of this.sessions.values()) {
        if (!existing.terminal) await this.finishUnlocked(existing, "CANCELLED");
      }

      const id = randomUUID();
      const events = new ReplaySubject<MessageEvent>(1);
      const created: InternalQrSession = {
        id,
        ownerId,
        status: "CREATED",
        qrImage: null,
        loginUrl: null,
        qrState: null,
        expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
        accountName: null,
        shopCount: null,
        error: null,
        events,
        context: null,
        page: null,
        terminal: false,
        tokenAccepted: false,
        expiryTimer: null,
        tokenPoll: null,
        authPoll: null,
        authPollBusy: false,
      };
      created.expiryTimer = setTimeout(() => void this.finish(created, "EXPIRED"), 4 * 60_000);
      created.expiryTimer.unref();
      this.sessions.set(id, created);
      this.activeSessionId = id;
      await this.persistCreate(created);
      this.emit(created);
      return created;
    });

    try {
      await this.startBrowserSession(session);
    } catch (error) {
      await this.finish(session, "FAILED", {
        code: "AUTH_BROWSER_START_FAILED",
        message: "云端登录浏览器启动失败",
        recovery: error instanceof Error && error.message.includes("executable")
          ? "请配置 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"
          : "请稍后重试或检查云端 Chromium",
      });
    }

    return this.toPublic(session);
  }

  get(id: string, ownerId = "demo-user"): PublicQrSession | null {
    const session = this.sessions.get(id);
    return session?.ownerId === ownerId ? this.toPublic(session) : null;
  }

  events(id: string, ownerId = "demo-user"): Observable<MessageEvent> | null {
    const session = this.sessions.get(id);
    return session?.ownerId === ownerId ? session.events.asObservable() : null;
  }

  async cancel(id: string, ownerId = "demo-user"): Promise<PublicQrSession | null> {
    return this.withSessionMutation(async () => {
      const session = this.sessions.get(id);
      if (!session || session.ownerId !== ownerId) return null;
      await this.finishUnlocked(session, "CANCELLED");
      return this.toPublic(session);
    });
  }

  async onApplicationShutdown() {
    await Promise.all([...this.sessions.values()].map((session) => this.cleanupContext(session)));
    if (this.browser) await this.browser.close();
  }

  private async startBrowserSession(session: InternalQrSession) {
    const qr = await this.fuduo.getQrLogin();
    assertQrLoginTargets(qr.url, qr.redirectUri);
    session.loginUrl = qr.url;
    session.qrState = qr.state;

    const browser = await this.getBrowser();
    if (session.terminal) return;
    const context = await browser.newContext({
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: 520, height: 640 },
    });
    if (session.terminal) {
      await context.close().catch(() => undefined);
      return;
    }
    session.context = context;
    await context.route("**/*", async (route) => {
      if (isAllowedAuthBrowserUrl(route.request().url())) await route.continue();
      else await route.abort("blockedbyclient");
    });
    session.page = await context.newPage();
    session.page.on("framenavigated", (frame) => {
      void this.inspectNavigation(session, frame.url());
    });
    session.page.on("request", (request) => {
      const url = request.url();
      if (isTrustedFuduoCallbackUrl(url)) void this.inspectNavigation(session, url);
    });

    await session.page.goto(qr.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (session.terminal) return;
    const qrImage = await this.captureQr(session.page);
    const started = await this.withSessionMutation(async () => {
      if (session.terminal || this.activeSessionId !== session.id) return false;
      session.qrImage = qrImage;
      session.status = "WAITING_SCAN";
      await this.persist(session);
      this.emit(session);
      return true;
    });
    if (!started) return;

    session.tokenPoll = setInterval(() => void this.inspectPageStorage(session), 500);
    session.tokenPoll.unref();
    session.authPoll = setInterval(() => void this.pollLoginResult(session), 1_000);
    session.authPoll.unref();
    void this.pollLoginResult(session);
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    const executablePath = findChromiumExecutable();
    if (!executablePath) throw new Error("Chromium executable was not found");
    this.launching = chromium.launch({ executablePath, headless: true }).then((browser) => {
      this.browser = browser;
      browser.on("disconnected", () => { this.browser = null; });
      return browser;
    });
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  private async captureQr(page: Page): Promise<string> {
    const selectors = [
      "canvas",
      "img[src*='qr']",
      "img[src*='code']",
      ".ww_loginImg",
      ".qrcode",
      "[class*='qrcode']",
      "[class*='qr_code']",
    ];
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.isVisible({ timeout: 1_500 })) {
          const box = await locator.boundingBox();
          if (box && box.width >= 100 && box.height >= 100) {
            const image = await locator.screenshot({ type: "png" });
            return `data:image/png;base64,${image.toString("base64")}`;
          }
        }
      } catch {
        // Try the next known QR selector.
      }
    }
    throw new Error("QR element was not found");
  }

  private async inspectNavigation(session: InternalQrSession, url: string) {
    if (session.terminal) return;
    if (!isTrustedFuduoCallbackUrl(url)) return;
    await this.markScanned(session);
    await this.acceptTokenFromUrl(session, url);
  }

  private async pollLoginResult(session: InternalQrSession) {
    if (!session.qrState || session.terminal || session.tokenAccepted || session.authPollBusy) return;
    session.authPollBusy = true;
    try {
      const result = await this.fuduo.pollQrLogin(session.qrState);
      const outcome = interpretQrLoginPoll(result);
      if (outcome.kind === "PENDING") return;
      await this.markScanned(session);
      if (outcome.kind === "SCANNED") return;
      if (outcome.kind === "TOKEN") {
        await this.acceptToken(session, outcome.token);
        return;
      }
      await this.finish(session, "FAILED", outcome.error);
    } catch {
      // A transient polling error must not invalidate a still-active QR session.
    } finally {
      session.authPollBusy = false;
    }
  }

  private async markScanned(session: InternalQrSession) {
    await this.withSessionMutation(async () => {
      if (session.status !== "WAITING_SCAN" || session.terminal || this.activeSessionId !== session.id) return;
      session.status = "SCANNED";
      await this.persist(session);
      this.emit(session);
    });
  }

  private async acceptTokenFromUrl(session: InternalQrSession, value: string) {
    try {
      const token = new URL(value).searchParams.get("token");
      if (token) await this.acceptToken(session, token);
    } catch {
      // Navigation URLs are untrusted input; invalid URLs are ignored.
    }
  }

  private async inspectPageStorage(session: InternalQrSession) {
    if (!session.page || session.terminal || session.tokenAccepted) return;
    try {
      const token = await session.page.evaluate(() => window.localStorage.getItem("biz_token"));
      if (token) await this.acceptToken(session, token);
    } catch {
      // Cross-origin navigation can make localStorage temporarily unavailable.
    }
  }

  private async acceptToken(session: InternalQrSession, token: string) {
    await this.withSessionMutation(async () => {
      if (session.tokenAccepted || session.terminal || this.activeSessionId !== session.id) return;
      session.tokenAccepted = true;
      session.status = "VERIFYING";
      session.qrImage = null;
      await this.persist(session);
      this.emit(session);
      try {
        // Keep the session lock through verification and credential commit. A
        // concurrent cancel/replacement therefore either wins before commit, or
        // observes SUCCESS instead of falsely reporting a cancelled write.
        const status = await this.credentials.importToken(token, true);
        session.accountName = status.accountName;
        session.shopCount = status.shopCount;
        await this.finishUnlocked(session, "SUCCESS");
      } catch {
        await this.finishUnlocked(session, "FAILED", {
          code: "ERP_TOKEN_VERIFY_FAILED",
          message: "扫码结果未能通过富多账号验证",
          recovery: "请生成新二维码后重新扫码",
        });
      }
    });
  }

  private async finish(
    session: InternalQrSession,
    status: Extract<QrStatus, "SUCCESS" | "FAILED" | "EXPIRED" | "CANCELLED">,
    error: PublicQrSession["error"] = null,
  ) {
    await this.withSessionMutation(() => this.finishUnlocked(session, status, error));
  }

  private async finishUnlocked(
    session: InternalQrSession,
    status: Extract<QrStatus, "SUCCESS" | "FAILED" | "EXPIRED" | "CANCELLED">,
    error: PublicQrSession["error"] = null,
  ) {
    if (session.terminal) return;
    session.terminal = true;
    session.status = status;
    session.error = error;
    session.qrImage = null;
    if (session.expiryTimer) clearTimeout(session.expiryTimer);
    session.expiryTimer = null;
    if (session.tokenPoll) clearInterval(session.tokenPoll);
    session.tokenPoll = null;
    if (session.authPoll) clearInterval(session.authPoll);
    session.authPoll = null;
    await this.cleanupContext(session);
    await this.persist(session, new Date());
    if (this.activeSessionId === session.id) this.activeSessionId = null;
    this.emit(session);
    session.events.complete();
    const removeTimer = setTimeout(() => this.sessions.delete(session.id), 10 * 60_000);
    removeTimer.unref();
  }

  private async withSessionMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionMutation;
    let release!: () => void;
    this.sessionMutation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async cleanupContext(session: InternalQrSession) {
    const context = session.context;
    session.context = null;
    session.page = null;
    if (context) await context.close().catch(() => undefined);
  }

  private emit(session: InternalQrSession) {
    session.events.next({ type: "status", data: this.toPublic(session) });
  }

  private async persistCreate(session: InternalQrSession) {
    if (!this.database?.enabled) return;
    await this.database.prisma.loginSession.create({
      data: {
        id: session.id,
        ownerId: session.ownerId,
        status: session.status,
        expiresAt: new Date(session.expiresAt),
      },
    });
  }

  private async persist(session: InternalQrSession, finishedAt?: Date) {
    if (!this.database?.enabled) return;
    await this.database.prisma.loginSession.update({
      where: { id: session.id },
      data: {
        status: session.status,
        accountName: session.accountName,
        shopCount: session.shopCount,
        errorCode: session.error?.code ?? null,
        errorMessage: session.error?.message ?? null,
        errorRecovery: session.error?.recovery ?? null,
        ...(finishedAt ? { finishedAt } : {}),
      },
    });
  }

  private toPublic(session: InternalQrSession): PublicQrSession {
    return {
      id: session.id,
      status: session.status,
      qrImage: session.qrImage,
      expiresAt: session.expiresAt,
      accountName: session.accountName,
      shopCount: session.shopCount,
      error: session.error,
    };
  }
}

type QrPollOutcome =
  | { kind: "PENDING" }
  | { kind: "SCANNED" }
  | { kind: "TOKEN"; token: string }
  | { kind: "FAILED"; error: NonNullable<PublicQrSession["error"]> };

export function interpretQrLoginPoll(result: QrLoginPoll): QrPollOutcome {
  const status = result.pollStatus.trim().toUpperCase();
  if (status === "PENDING" || status === "WAITING") return { kind: "PENDING" };
  if (["SCANNED", "CONFIRMING", "AUTHORIZING", "PROCESSING", "VERIFYING"].includes(status)) return { kind: "SCANNED" };
  const token = result.login?.accessToken?.trim();
  if ((status === "OK" || status === "SUCCESS") && token) return { kind: "TOKEN", token };

  const reasons: Record<string, { message: string; recovery: string }> = {
    AUTH_FAILED: { message: "企业微信授权失败", recovery: "请生成新二维码后重新扫码" },
    DISABLED: { message: "富多账号已被停用", recovery: result.login?.disableReason?.trim() || "请联系富多管理员" },
    NEED_AUDIT: { message: "富多账号需要管理员审核", recovery: "审核通过后请重新扫码" },
    EXPIRED: { message: "二维码已失效", recovery: "请生成新二维码后重新扫码" },
  };
  const reason = reasons[status] ?? {
    message: "富多未返回可用的登录凭证",
    recovery: "请生成新二维码后重新扫码",
  };
  return {
    kind: "FAILED",
    error: { code: `ERP_QR_${status}`, ...reason },
  };
}

function findChromiumExecutable(): string | undefined {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const candidates = [
    configured,
    process.platform === "win32" ? `${process.env.PROGRAMFILES ?? ""}\\Microsoft\\Edge\\Application\\msedge.exe` : undefined,
    process.platform === "win32" ? `${process.env["PROGRAMFILES(X86)"] ?? ""}\\Microsoft\\Edge\\Application\\msedge.exe` : undefined,
    process.platform === "win32" ? `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate));
}

const QR_LOGIN_HOSTS = new Set(["login.work.weixin.qq.com", "open.work.weixin.qq.com"]);
const AUTH_BROWSER_DOMAIN_SUFFIXES = [
  "weixin.qq.com",
  "wx.qq.com",
  "qpic.cn",
  "gtimg.com",
  "tencent.com",
  "fuduo8888.com",
] as const;

export function isTrustedQrLoginUrl(value: string): boolean {
  const url = safeUrl(value);
  return Boolean(url && url.protocol === "https:" && !url.username && !url.password && !url.port && QR_LOGIN_HOSTS.has(url.hostname));
}

export function isTrustedFuduoCallbackUrl(value: string): boolean {
  const url = safeUrl(value);
  return Boolean(
    url
    && url.protocol === "https:"
    && !url.username
    && !url.password
    && !url.port
    && !url.hash
    && trustedFuduoHosts().has(url.hostname)
    && url.pathname.replace(/\/+$/, "") === "/wecom-callback",
  );
}

export function isAllowedAuthBrowserUrl(value: string): boolean {
  const url = safeUrl(value);
  if (!url) return false;
  if (url.protocol === "data:" || url.protocol === "blob:" || url.protocol === "about:") return true;
  return url.protocol === "https:"
    && !url.username
    && !url.password
    && !url.port
    && AUTH_BROWSER_DOMAIN_SUFFIXES.some((suffix) => url.hostname === suffix || url.hostname.endsWith(`.${suffix}`));
}

function assertQrLoginTargets(loginUrl: string, redirectUri: string) {
  const redirect = safeUrl(redirectUri);
  if (!isTrustedQrLoginUrl(loginUrl) || !isTrustedFuduoCallbackUrl(redirectUri) || redirect?.search) {
    throw new Error("AUTH_BROWSER_TARGET_NOT_ALLOWED");
  }
}

function trustedFuduoHosts() {
  const hosts = new Set(["erp.fuduo8888.com"]);
  const configured = safeUrl(process.env.FUDUO_API_BASE_URL ?? "");
  if (configured?.protocol === "https:") hosts.add(configured.hostname);
  return hosts;
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
