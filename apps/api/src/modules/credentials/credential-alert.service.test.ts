import { describe, expect, it, vi } from "vitest";
import { CredentialAlertService } from "./credential-alert.service.js";

describe("CredentialAlertService", () => {
  it("notifies each uniquely paired active administrator", async () => {
    const findMany = vi.fn(async () => [
      { externalUserId: "admin-a@im.wechat" },
      { externalUserId: "admin-a@im.wechat" },
      { externalUserId: "admin-b@im.wechat" },
    ]);
    const send = vi.fn(async (recipient: string, _text?: string) => {
      if (recipient.startsWith("admin-b")) throw new Error("WECHAT_DELIVERY_FAILED");
      return { messageId: "message-1" };
    });
    const service = new CredentialAlertService(
      { enabled: true, prisma: { channelUser: { findMany } } } as never,
      { send } as never,
    );

    await expect(service.notifyReauthRequired()).resolves.toEqual({ total: 2, sent: 1, failed: 1 });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        revokedAt: null,
        user: { active: true, userRoles: { some: { role: { code: "ADMIN" } } } },
        channelAccount: { channel: "openclaw-weixin", active: true },
      },
      select: { externalUserId: true },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith("admin-a@im.wechat", expect.stringContaining("重新扫码"));
    expect(String(send.mock.calls[0]?.[1])).not.toMatch(/Bearer|Authorization|Cookie/i);
  });

  it("returns an empty result without sending in demo mode", async () => {
    const send = vi.fn();
    const service = new CredentialAlertService({ enabled: false } as never, { send } as never);
    await expect(service.notifyReauthRequired()).resolves.toEqual({ total: 0, sent: 0, failed: 0, demo: true });
    expect(send).not.toHaveBeenCalled();
  });
});
