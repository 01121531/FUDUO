import { describe, expect, it, vi } from "vitest";
import { WechatLoginManager } from "./wechat-login-manager.js";

function controlledDependencies() {
  let resolveWait!: (value: { connected: boolean; botToken?: string; accountId?: string; baseUrl?: string; userId?: string; message: string }) => void;
  let waitOptions: {
    onProgress: (progress: { type: "SCANNED" } | { type: "VERIFY_CODE_REQUIRED"; retry: boolean } | { type: "QR_REFRESHED"; qrContent: string }) => void;
    getVerificationCode: (retry: boolean) => Promise<string>;
  } | null = null;
  const wait = vi.fn((options: NonNullable<typeof waitOptions>) => {
    waitOptions = options;
    return new Promise((resolve) => { resolveWait = resolve; });
  });
  const dependencies = {
    configured: () => true,
    start: vi.fn(async () => ({ qrcodeUrl: "https://weixin.qq.com/x/test", message: "scan", sessionKey: "sdk-session" })),
    wait,
    listAccounts: vi.fn((): string[] => []),
    loadAccount: vi.fn(() => null),
    saveAccount: vi.fn(),
    registerAccount: vi.fn(),
    clearStale: vi.fn(),
    reload: vi.fn(async () => undefined),
  };
  return {
    dependencies,
    resolveWait: (value: Parameters<typeof resolveWait>[0]) => resolveWait(value),
    progress: (value: Parameters<NonNullable<typeof waitOptions>["onProgress"]>[0]) => waitOptions?.onProgress(value),
    requestVerificationCode: (retry = false) => waitOptions?.getVerificationCode(retry),
  };
}

describe("WechatLoginManager", () => {
  it("starts one real QR session and reuses it while pending", async () => {
    const { dependencies } = controlledDependencies();
    const manager = new WechatLoginManager(dependencies as never);
    const first = await manager.start();
    const second = await manager.start();

    expect(first).toMatchObject({ status: "PENDING", qrDataUrl: "https://weixin.qq.com/x/test" });
    expect(second.sessionId).toBe(first.sessionId);
    expect(dependencies.start).toHaveBeenCalledOnce();
  });

  it("shares one start operation across concurrent requests", async () => {
    const { dependencies } = controlledDependencies();
    let release!: () => void;
    dependencies.start.mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { qrcodeUrl: "qr-content", message: "scan", sessionKey: "sdk-session" };
    });
    const manager = new WechatLoginManager(dependencies as never);
    const first = manager.start();
    const second = manager.start();
    release();

    const [left, right] = await Promise.all([first, second]);
    expect(left.sessionId).toBe(right.sessionId);
    expect(dependencies.start).toHaveBeenCalledOnce();
  });

  it("publishes scanned, refreshed QR, and verification-code states", async () => {
    const { dependencies, progress, requestVerificationCode } = controlledDependencies();
    const manager = new WechatLoginManager(dependencies as never);
    await manager.start();

    progress({ type: "SCANNED" });
    expect(manager.status()).toMatchObject({ status: "SCANNED", message: "已扫码，请在手机上确认" });
    progress({ type: "QR_REFRESHED", qrContent: "new-qr-content" });
    expect(manager.status()).toMatchObject({ status: "PENDING", qrDataUrl: "new-qr-content" });
    const codePromise = requestVerificationCode();
    expect(manager.status().status).toBe("VERIFY_CODE_REQUIRED");
    expect(manager.submitVerificationCode("123456").status).toBe("SCANNED");
    await expect(codePromise).resolves.toBe("123456");
  });

  it("persists a confirmed account and exposes success without the token", async () => {
    const { dependencies, resolveWait } = controlledDependencies();
    dependencies.listAccounts.mockReturnValueOnce([]).mockReturnValue(["bot-im-bot"]);
    const manager = new WechatLoginManager(dependencies as never);
    await manager.start();
    resolveWait({ connected: true, botToken: "secret-bot-token", accountId: "bot@im.bot", baseUrl: "https://ilinkai.weixin.qq.com", userId: "user-1", message: "ok" });
    await vi.waitFor(() => expect(manager.status().status).toBe("SUCCESS"));

    expect(dependencies.saveAccount).toHaveBeenCalledWith("bot-im-bot", expect.objectContaining({ token: "secret-bot-token" }));
    expect(dependencies.registerAccount).toHaveBeenCalledWith("bot-im-bot");
    expect(dependencies.reload).toHaveBeenCalledOnce();
    expect(JSON.stringify(manager.status())).not.toContain("secret-bot-token");
  });

  it("ignores a late successful result after cancellation", async () => {
    const { dependencies, resolveWait } = controlledDependencies();
    const manager = new WechatLoginManager(dependencies as never);
    await manager.start();
    expect(manager.cancel().status).toBe("CANCELLED");
    resolveWait({ connected: true, botToken: "late-token", accountId: "late@im.bot", message: "ok" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.status().status).toBe("CANCELLED");
    expect(dependencies.saveAccount).not.toHaveBeenCalled();
  });

  it("does not cancel after credential commit has started", async () => {
    const { dependencies, resolveWait } = controlledDependencies();
    let finishReload!: () => void;
    dependencies.reload.mockImplementation(() => new Promise<void>((resolve) => { finishReload = resolve; }).then(() => undefined));
    const manager = new WechatLoginManager(dependencies as never);
    await manager.start();
    resolveWait({ connected: true, botToken: "secret", accountId: "bot@im.bot", message: "ok" });
    await vi.waitFor(() => expect(manager.status().status).toBe("COMMITTING"));

    expect(manager.cancel().status).toBe("COMMITTING");
    finishReload();
    await vi.waitFor(() => expect(manager.status().status).toBe("SUCCESS"));
  });

  it("rejects verification codes outside the numeric format", async () => {
    const { dependencies, requestVerificationCode } = controlledDependencies();
    const manager = new WechatLoginManager(dependencies as never);
    await manager.start();
    void requestVerificationCode();
    expect(() => manager.submitVerificationCode("12ab")).toThrow("WECHAT_VERIFY_CODE_INVALID");
  });
});
