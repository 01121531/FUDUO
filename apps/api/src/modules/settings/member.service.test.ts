import { describe, expect, it, vi } from "vitest";
import { AccessControlService } from "../auth/access-control.service.js";
import { DatabaseService } from "../database/database.service.js";
import { DemoDataService } from "../demo/demo-data.service.js";
import { MemberService } from "./member.service.js";

function service() {
  const database = new DatabaseService();
  const demo = new DemoDataService();
  return new MemberService(database, demo, new AccessControlService(database));
}

describe("MemberService", () => {
  it("creates a scoped employee without returning the temporary password", async () => {
    const members = service();
    const options = await members.options();
    const shopId = options.shops[0]!.id;
    const created = await members.create({
      displayName: "经营同事",
      email: "operator@example.com",
      temporaryPassword: "temporary-password-123",
      roleCode: "OPERATOR",
      shopIds: [shopId],
    });

    expect(created).toEqual(expect.objectContaining({ roleCode: "OPERATOR", shopIds: [shopId], shopScope: "1 家店铺" }));
    expect(JSON.stringify(created)).not.toContain("temporary-password-123");
  });

  it("updates role and scope while preventing the demo administrator from locking itself out", async () => {
    const members = service();
    const created = await members.create({
      displayName: "只读同事",
      email: "viewer@example.com",
      temporaryPassword: "temporary-password-456",
      roleCode: "VIEWER",
      shopIds: [],
    });

    await expect(members.update(created.id, { active: false })).resolves.toEqual(expect.objectContaining({ active: false }));
    await expect(members.update("demo-admin", { active: false })).rejects.toThrow("MEMBER_SELF_LOCKOUT");
    await expect(members.update("demo-admin", { roleCode: "VIEWER" })).rejects.toThrow("MEMBER_SELF_LOCKOUT");
  });

  it("rejects duplicate login emails", async () => {
    const members = service();
    await expect(members.create({ displayName: "重复账号", email: "ADMIN@example.com", temporaryPassword: "temporary-password-789", roleCode: "VIEWER", shopIds: [] }))
      .rejects.toThrow("MEMBER_EMAIL_EXISTS");
  });

  it("keeps the final active administrator in production", async () => {
    const database = {
      enabled: true,
      prisma: {
        user: { findUnique: async () => ({ id: "admin-1", email: "admin@example.com", active: true, userRoles: [{ role: { code: "ADMIN" } }] }) },
        userRole: { count: async () => 0 },
      },
    };
    const access = { scope: async () => ({ permissions: ["*"] }) };
    const members = new MemberService(database as never, new DemoDataService(), access as never);
    await expect(members.update("admin-1", { roleCode: "VIEWER" }, "admin-2")).rejects.toThrow("MEMBER_LAST_ADMIN");
  });

  it("marks a production employee temporary password for mandatory change", async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data, id: "user-1", displayName: "经营同事", email: "operator@example.com", active: true, createdAt: new Date(),
      userRoles: [{ role: { code: "OPERATOR", name: "经营人员", permissions: ["data:read"] } }], shopScopes: [], channelUsers: [],
    }));
    const database = {
      enabled: true,
      prisma: {
        user: { findUnique: vi.fn(async () => null) },
        role: { findUnique: vi.fn(async () => ({ id: "role-1" })) },
        shop: { count: vi.fn(async () => 0) },
        $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation({ user: { create }, auditLog: { create: vi.fn() } }),
      },
    };
    const access = { scope: vi.fn(async () => ({ permissions: ["*"] })), ensureBuiltInRoles: vi.fn(async () => []) };
    const members = new MemberService(database as never, new DemoDataService(), access as never);

    await members.create({ displayName: "经营同事", email: "operator@example.com", temporaryPassword: "temporary-password-123", roleCode: "OPERATOR", shopIds: [] }, "admin-1");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ mustChangePassword: true }) }));
  });

  it("marks a reset password for mandatory change and revokes sessions", async () => {
    const userUpdate = vi.fn(async () => ({}));
    const sessionUpdate = vi.fn(async () => ({ count: 2 }));
    const database = {
      enabled: true,
      prisma: {
        user: { findUnique: vi.fn(async () => ({ id: "user-1", email: "user@example.com" })), update: userUpdate },
        userSession: { updateMany: sessionUpdate },
        auditLog: { create: vi.fn(async () => ({})) },
        $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
      },
    };
    const access = { scope: vi.fn(async () => ({ permissions: ["*"] })) };
    const members = new MemberService(database as never, new DemoDataService(), access as never);

    await members.resetPassword("user-1", "temporary-password-456", "admin-1");
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ mustChangePassword: true }) }));
    expect(sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-1", revokedAt: null } }));
  });
});
