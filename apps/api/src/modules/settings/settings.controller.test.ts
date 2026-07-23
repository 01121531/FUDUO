import { describe, expect, it } from "vitest";
import { SettingsController } from "./settings.controller.js";

function controller() {
  return new SettingsController({ enabled: false } as never, { configured: false } as never);
}

describe("SettingsController", () => {
  it("filters audit events by channel, result, and search text", async () => {
    const response = await controller().audit("同步", "worker", "partial", undefined, undefined, undefined, undefined, undefined, "20");
    expect(response.success).toBe(true);
    expect(response.data).toHaveLength(1);
    expect(response.data[0]).toEqual(expect.objectContaining({ channel: "WORKER", result: "PARTIAL", resource: "晴川百货" }));
  });

  it("filters audit events by user, tool, shop, and date", async () => {
    const response = await controller().audit(
      undefined,
      undefined,
      undefined,
      "系统任务",
      "sales-live",
      "晴川",
      "2026-07-21",
      "2026-07-21",
      "20",
    );
    expect(response.data).toHaveLength(1);
    expect(response.data[0]).toEqual(expect.objectContaining({
      tool: "sales-live-sync",
      resource: "晴川百货",
      params: { tradeDate: "2026-07-21", shopName: "晴川百货" },
    }));
  });

  it("binds an approved pairing to an active internal user", async () => {
    let upsertInput: unknown;
    const transaction = {
      channelAccount: { upsert: async () => ({ id: "channel-1" }) },
      channelUser: {
        upsert: async (input: unknown) => {
          upsertInput = input;
          return { id: "pairing-1", externalUserId: "wx-user-1", pairedAt: new Date("2026-07-21T08:00:00Z") };
        },
      },
      auditLog: { create: async () => ({ id: "audit-1" }) },
    };
    const database = {
      enabled: true,
      prisma: {
        userRole: { findMany: async () => [{ role: { permissions: ["*"] } }] },
        user: { findFirst: async () => ({ id: "11111111-1111-4111-8111-111111111111", displayName: "测试员工", email: "employee@example.com" }) },
        $transaction: async (callback: (value: typeof transaction) => unknown) => callback(transaction),
      },
    };
    const admin = {
      configured: true,
      approve: async () => ({ externalUserId: "wx-user-1", meta: { nickname: "店长小王" } }),
      revoke: async () => ({ revoked: true }),
    };
    const response = await new SettingsController(database as never, admin as never).approveWechatPairing(
      { code: "ABCDEFGH", userId: "11111111-1111-4111-8111-111111111111" },
      { user: { id: "22222222-2222-4222-8222-222222222222", email: "admin@example.com", displayName: "管理员" } },
    );
    expect(response.data).toEqual(expect.objectContaining({
      externalUserId: "wx-user-1",
      wechatNickname: "店长小王",
      pairingStatus: "PAIRED",
      internalUser: expect.objectContaining({ displayName: "测试员工" }),
    }));
    expect(upsertInput).toEqual(expect.objectContaining({
      create: expect.objectContaining({ externalDisplayName: "店长小王" }),
      update: expect.objectContaining({ externalDisplayName: "店长小王" }),
    }));
    expect((upsertInput as { update: Record<string, unknown> }).update).not.toHaveProperty("pairedAt");
  });

  it("returns explicit pairing statuses without inventing a missing WeChat nickname", async () => {
    const database = {
      enabled: true,
      prisma: {
        channelUser: {
          findMany: async () => [
            {
              id: "pairing-confirmed",
              externalUserId: "wx-confirmed",
              externalDisplayName: "微信小李",
              pairedAt: new Date("2026-07-20T08:00:00Z"),
              user: { id: "user-1", displayName: "李店长", email: "li@example.com" },
              channelAccount: { channel: "openclaw-weixin" },
            },
            {
              id: "pairing-stale",
              externalUserId: "wx-stale",
              externalDisplayName: null,
              pairedAt: new Date("2026-07-19T08:00:00Z"),
              user: { id: "user-2", displayName: "王店长", email: "wang@example.com" },
              channelAccount: { channel: "openclaw-weixin" },
            },
          ],
        },
      },
    };
    const admin = {
      configured: true,
      list: async () => ({
        pending: [{
          id: "wx-pending",
          code: "ABCDEFGH",
          createdAt: "2026-07-21T08:00:00Z",
          lastSeenAt: "2026-07-21T08:01:00Z",
          meta: { displayName: "待审批用户" },
        }],
        approved: ["wx-confirmed", "wx-unbound"],
      }),
      loginStatus: async () => ({ status: "SUCCESS" }),
    };

    const response = await new SettingsController(database as never, admin as never).wechat();

    expect(response.data.pending).toEqual([
      expect.objectContaining({ wechatNickname: "待审批用户", pairingStatus: "PENDING" }),
    ]);
    expect(response.data.approvedUnbound).toEqual([
      { externalUserId: "wx-unbound", wechatNickname: null, pairingStatus: "UNBOUND" },
    ]);
    expect(response.data.pairings).toEqual([
      expect.objectContaining({
        id: "pairing-confirmed",
        wechatNickname: "微信小李",
        pairingStatus: "PAIRED",
        internalUser: expect.objectContaining({ displayName: "李店长" }),
      }),
      expect.objectContaining({
        id: "pairing-stale",
        wechatNickname: null,
        pairingStatus: "NEEDS_REVIEW",
      }),
    ]);
  });

  it("marks persisted pairings as unknown while the OpenClaw management API is unavailable", async () => {
    const database = {
      enabled: true,
      prisma: {
        channelUser: {
          findMany: async () => [{
            id: "pairing-1",
            externalUserId: "wx-user-1",
            externalDisplayName: null,
            pairedAt: new Date("2026-07-20T08:00:00Z"),
            user: { id: "user-1", displayName: "内部员工", email: "user@example.com" },
            channelAccount: { channel: "openclaw-weixin" },
          }],
        },
      },
    };
    const admin = {
      configured: true,
      list: async () => { throw new Error("OPENCLAW_UNAVAILABLE"); },
      loginStatus: async () => { throw new Error("OPENCLAW_UNAVAILABLE"); },
    };

    const response = await new SettingsController(database as never, admin as never).wechat();

    expect(response.data.managementStatus).toBe("UNAVAILABLE");
    expect(response.data.pairings).toEqual([
      expect.objectContaining({
        wechatNickname: null,
        pairingStatus: "UNKNOWN",
      }),
    ]);
  });

  it("revokes the OpenClaw approval when database binding fails", async () => {
    let compensated = false;
    const database = {
      enabled: true,
      prisma: {
        userRole: { findMany: async () => [{ role: { permissions: ["*"] } }] },
        user: { findFirst: async () => ({ id: "11111111-1111-4111-8111-111111111111", displayName: "测试员工" }) },
        $transaction: async () => { throw new Error("DATABASE_FAILED"); },
      },
    };
    const admin = {
      configured: true,
      approve: async () => ({ externalUserId: "wx-user-2", meta: {} }),
      revoke: async () => { compensated = true; },
    };
    await expect(new SettingsController(database as never, admin as never).approveWechatPairing(
      { code: "ABCDEFGH", userId: "11111111-1111-4111-8111-111111111111" },
      { user: { id: "22222222-2222-4222-8222-222222222222", email: "admin@example.com", displayName: "管理员" } },
    )).rejects.toThrow("DATABASE_FAILED");
    expect(compensated).toBe(true);
  });
});
