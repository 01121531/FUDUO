import { describe, expect, it, vi } from "vitest";
import { AccessControlService } from "./access-control.service.js";

describe("AccessControlService", () => {
  it("limits non-admin users to explicitly assigned shops", async () => {
    const database = {
      enabled: true,
      prisma: {
        user: {
          findUnique: vi.fn(async () => ({
            id: "user-1",
            active: true,
            userRoles: [{ role: { permissions: ["data:read", "chat:use"] } }],
            shopScopes: [
              { shop: { fuduoShopId: 101n, status: "ACTIVE" } },
              { shop: { fuduoShopId: 102n, status: "ACTIVE" } },
              { shop: { fuduoShopId: 103n, status: "ARCHIVED" } },
            ],
          })),
        },
      },
    };
    const access = new AccessControlService(database as never);

    await expect(access.readableShopIds("user-1")).resolves.toEqual(["101", "102"]);
    await expect(access.readableShopIds("user-1", ["102"])).resolves.toEqual(["102"]);
    await expect(access.readableShopIds("user-1", ["999"])).rejects.toThrow("无权查看");
  });

  it("allows administrators to query all shops while preserving explicit filters", async () => {
    const database = {
      enabled: true,
      prisma: {
        user: { findUnique: vi.fn(async () => ({ id: "admin", active: true, userRoles: [{ role: { permissions: ["*"] } }], shopScopes: [] })) },
      },
    };
    const access = new AccessControlService(database as never);
    await expect(access.readableShopIds("admin")).resolves.toBeNull();
    await expect(access.readableShopIds("admin", ["201"])).resolves.toEqual(["201"]);
  });

  it("resolves only active approved WeChat pairings", async () => {
    const findFirst = vi.fn(async ({ where }: { where: { externalUserId: string } }) => where.externalUserId === "wx-approved" ? { userId: "user-1" } : null);
    const access = new AccessControlService({ enabled: true, prisma: { channelUser: { findFirst } } } as never);

    await expect(access.resolveChannelUser("wx-approved")).resolves.toBe("user-1");
    await expect(access.resolveChannelUser("wx-revoked")).rejects.toThrow("CHANNEL_USER_NOT_PAIRED");
    await expect(access.resolveChannelUser(undefined)).rejects.toThrow("CHANNEL_USER_ID_REQUIRED");
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ revokedAt: null, user: { active: true } }) }));
  });
});
