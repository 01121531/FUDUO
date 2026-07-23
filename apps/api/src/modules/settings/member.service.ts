import { randomUUID } from "node:crypto";
import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { DatabaseService } from "../database/database.service.js";
import { DemoDataService } from "../demo/demo-data.service.js";
import { AccessControlService, BUILT_IN_ROLES } from "../auth/access-control.service.js";
import { hashPassword } from "../auth/auth.service.js";

export type MemberRoleCode = "ADMIN" | "OPERATOR" | "VIEWER";

export interface CreateMemberInput {
  displayName: string;
  email: string;
  temporaryPassword: string;
  roleCode: MemberRoleCode;
  shopIds: string[];
}

export interface UpdateMemberInput {
  displayName?: string;
  roleCode?: MemberRoleCode;
  shopIds?: string[];
  active?: boolean;
}

interface DemoMember {
  id: string;
  displayName: string;
  email: string;
  roleCode: MemberRoleCode;
  shopIds: string[];
  active: boolean;
  passwordHash: string;
  createdAt: string;
}

@Injectable()
export class MemberService {
  private readonly demoMembers = new Map<string, DemoMember>();

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(DemoDataService) private readonly demo: DemoDataService,
    @Inject(AccessControlService) private readonly access: AccessControlService,
  ) {
    if (!database.enabled) {
      this.demoMembers.set("demo-admin", {
        id: "demo-admin", displayName: "系统管理员", email: "admin@example.com", roleCode: "ADMIN", shopIds: [],
        active: true, passwordHash: hashPassword("demo-password"), createdAt: "2026-07-21T00:00:00.000Z",
      });
    }
  }

  async list(actorId?: string) {
    await this.assertManager(actorId);
    if (!this.database.enabled) return [...this.demoMembers.values()].map((member) => this.demoSummary(member));
    const users = await this.database.prisma.user.findMany({
      include: {
        userRoles: { include: { role: true } },
        shopScopes: { include: { shop: true } },
        channelUsers: { where: { revokedAt: null }, include: { channelAccount: true }, orderBy: { pairedAt: "desc" }, take: 1 },
      },
      orderBy: [{ active: "desc" }, { displayName: "asc" }],
    });
    return users.map((user) => this.productionSummary(user));
  }

  async options(actorId?: string) {
    await this.assertManager(actorId);
    const roles = await this.access.ensureBuiltInRoles();
    if (!this.database.enabled) {
      return {
        roles: roles.map((role) => ({ code: role.code, name: role.name, permissions: [...role.permissions] })),
        shops: this.demo.shops.map((shop) => ({ id: `demo-shop-${shop.id}`, fuduoShopId: String(shop.id), name: shop.name, status: "ACTIVE" })),
      };
    }
    const shops = await this.database.prisma.shop.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { name: "asc" } });
    return {
      roles: roles.map((role) => ({ code: role.code, name: role.name, permissions: role.permissions })),
      shops: shops.map((shop) => ({ id: shop.id, fuduoShopId: String(shop.fuduoShopId), name: shop.name, status: shop.status })),
    };
  }

  async create(input: CreateMemberInput, actorId?: string) {
    await this.assertManager(actorId);
    const email = input.email.trim().toLowerCase();
    const displayName = required(input.displayName, "MEMBER_NAME_REQUIRED");
    if (!this.database.enabled) {
      if ([...this.demoMembers.values()].some((member) => member.email === email)) throw new Error("MEMBER_EMAIL_EXISTS");
      const member: DemoMember = {
        id: randomUUID(), displayName, email, roleCode: input.roleCode,
        shopIds: input.roleCode === "ADMIN" ? [] : unique(input.shopIds), active: true,
        passwordHash: hashPassword(input.temporaryPassword), createdAt: new Date().toISOString(),
      };
      this.demoMembers.set(member.id, member);
      return this.demoSummary(member);
    }
    if (await this.database.prisma.user.findUnique({ where: { email } })) throw new Error("MEMBER_EMAIL_EXISTS");
    const role = await this.role(input.roleCode);
    const shopIds = input.roleCode === "ADMIN" ? [] : await this.validatedShops(input.shopIds);
    const user = await this.database.prisma.$transaction(async (transaction) => {
      const created = await transaction.user.create({
        data: {
          email, displayName, passwordHash: hashPassword(input.temporaryPassword), mustChangePassword: true,
          userRoles: { create: { roleId: role.id } },
          ...(shopIds.length ? { shopScopes: { create: shopIds.map((shopId) => ({ shopId })) } } : {}),
        },
        include: { userRoles: { include: { role: true } }, shopScopes: { include: { shop: true } }, channelUsers: true },
      });
      await transaction.auditLog.create({ data: { userId: actorId!, channel: "WEB", action: "创建员工", resource: email, result: "SUCCEEDED", traceId: randomUUID(), params: { roleCode: input.roleCode, shopCount: shopIds.length } } });
      return created;
    });
    return this.productionSummary(user);
  }

  async update(id: string, input: UpdateMemberInput, actorId?: string) {
    await this.assertManager(actorId);
    if (Object.keys(input).length === 0) throw new Error("MEMBER_UPDATE_EMPTY");
    if (!this.database.enabled) {
      const member = this.demoMembers.get(id);
      if (!member) throw new Error("MEMBER_NOT_FOUND");
      if (id === "demo-admin" && (input.active === false || (input.roleCode && input.roleCode !== "ADMIN"))) throw new Error("MEMBER_SELF_LOCKOUT");
      if (input.displayName !== undefined) member.displayName = required(input.displayName, "MEMBER_NAME_REQUIRED");
      if (input.roleCode !== undefined) member.roleCode = input.roleCode;
      if (input.shopIds !== undefined) member.shopIds = member.roleCode === "ADMIN" ? [] : unique(input.shopIds);
      if (input.active !== undefined) member.active = input.active;
      return this.demoSummary(member);
    }
    const existing = await this.database.prisma.user.findUnique({ where: { id }, include: { userRoles: { include: { role: true } } } });
    if (!existing) throw new Error("MEMBER_NOT_FOUND");
    const currentRole = existing.userRoles[0]?.role.code as MemberRoleCode | undefined;
    const nextRole = input.roleCode ?? currentRole;
    if (!nextRole) throw new Error("MEMBER_ROLE_REQUIRED");
    if (id === actorId && (input.active === false || nextRole !== "ADMIN")) throw new Error("MEMBER_SELF_LOCKOUT");
    if (currentRole === "ADMIN" && (input.active === false || nextRole !== "ADMIN")) await this.assertAnotherAdmin(id);
    const role = input.roleCode ? await this.role(input.roleCode) : null;
    const shopIds = nextRole === "ADMIN" ? [] : input.shopIds !== undefined ? await this.validatedShops(input.shopIds) : null;
    const user = await this.database.prisma.$transaction(async (transaction) => {
      await transaction.user.update({ where: { id }, data: { ...(input.displayName !== undefined ? { displayName: required(input.displayName, "MEMBER_NAME_REQUIRED") } : {}), ...(input.active !== undefined ? { active: input.active } : {}) } });
      if (role) {
        await transaction.userRole.deleteMany({ where: { userId: id } });
        await transaction.userRole.create({ data: { userId: id, roleId: role.id } });
      }
      if (shopIds !== null || nextRole === "ADMIN") {
        await transaction.userShopScope.deleteMany({ where: { userId: id } });
        if (shopIds?.length) await transaction.userShopScope.createMany({ data: shopIds.map((shopId) => ({ userId: id, shopId })), skipDuplicates: true });
      }
      if (input.active === false) await transaction.userSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await transaction.auditLog.create({ data: { userId: actorId!, channel: "WEB", action: input.active === false ? "停用员工" : input.active === true ? "启用员工" : "更新员工权限", resource: existing.email, result: "SUCCEEDED", traceId: randomUUID(), params: { roleCode: nextRole, ...(shopIds !== null ? { shopCount: shopIds.length } : {}) } } });
      return transaction.user.findUniqueOrThrow({ where: { id }, include: { userRoles: { include: { role: true } }, shopScopes: { include: { shop: true } }, channelUsers: { where: { revokedAt: null }, include: { channelAccount: true }, take: 1 } } });
    });
    return this.productionSummary(user);
  }

  async resetPassword(id: string, temporaryPassword: string, actorId?: string) {
    await this.assertManager(actorId);
    if (!this.database.enabled) {
      const member = this.demoMembers.get(id);
      if (!member) throw new Error("MEMBER_NOT_FOUND");
      member.passwordHash = hashPassword(temporaryPassword);
      return { id, sessionsRevoked: true };
    }
    const user = await this.database.prisma.user.findUnique({ where: { id } });
    if (!user) throw new Error("MEMBER_NOT_FOUND");
    await this.database.prisma.$transaction([
      this.database.prisma.user.update({ where: { id }, data: { passwordHash: hashPassword(temporaryPassword), mustChangePassword: true } }),
      this.database.prisma.userSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
      this.database.prisma.auditLog.create({ data: { userId: actorId!, channel: "WEB", action: "重置员工密码", resource: user.email, result: "SUCCEEDED", traceId: randomUUID() } }),
    ]);
    return { id, sessionsRevoked: true };
  }

  private async assertManager(actorId?: string) {
    const scope = await this.access.scope(actorId);
    if (!scope.permissions.includes("*") && !scope.permissions.includes("settings:members")) throw new ForbiddenException("需要员工管理权限");
  }

  private async role(code: MemberRoleCode) {
    await this.access.ensureBuiltInRoles();
    const role = await this.database.prisma.role.findUnique({ where: { code } });
    if (!role) throw new Error("MEMBER_ROLE_REQUIRED");
    return role;
  }

  private async validatedShops(rawIds: string[]) {
    const shopIds = unique(rawIds);
    const count = await this.database.prisma.shop.count({ where: { id: { in: shopIds }, status: { not: "ARCHIVED" } } });
    if (count !== shopIds.length) throw new Error("MEMBER_SHOP_SCOPE_INVALID");
    return shopIds;
  }

  private async assertAnotherAdmin(excludingUserId: string) {
    const count = await this.database.prisma.userRole.count({ where: { userId: { not: excludingUserId }, user: { active: true }, role: { code: "ADMIN" } } });
    if (count === 0) throw new Error("MEMBER_LAST_ADMIN");
  }

  private demoSummary(member: DemoMember) {
    const role = BUILT_IN_ROLES.find((item) => item.code === member.roleCode)!;
    const shopNames = member.shopIds.map((id) => this.demo.shops.find((shop) => `demo-shop-${shop.id}` === id)?.name).filter((name): name is string => Boolean(name));
    return {
      id: member.id, displayName: member.displayName, email: member.email,
      roleCode: member.roleCode, roles: [role.name], permissions: [...role.permissions],
      shopIds: member.shopIds, shops: shopNames, shopScope: member.roleCode === "ADMIN" ? "全部店铺" : shopNames.length ? `${shopNames.length} 家店铺` : "未授权店铺",
      wechat: null, active: member.active, lastPairedAt: null, createdAt: member.createdAt,
    };
  }

  private productionSummary(user: {
    id: string; displayName: string; email: string; active: boolean; createdAt: Date;
    userRoles: Array<{ role: { code: string; name: string; permissions: string[] } }>;
    shopScopes: Array<{ shop: { id: string; name: string } }>;
    channelUsers: Array<{ externalUserId: string; pairedAt: Date }>;
  }) {
    const permissions = [...new Set(user.userRoles.flatMap((entry) => entry.role.permissions))];
    const channel = user.channelUsers[0];
    return {
      id: user.id, displayName: user.displayName, email: user.email,
      roleCode: user.userRoles[0]?.role.code ?? null, roles: user.userRoles.map((entry) => entry.role.name), permissions,
      shopIds: user.shopScopes.map((entry) => entry.shop.id), shops: user.shopScopes.map((entry) => entry.shop.name),
      shopScope: permissions.includes("*") ? "全部店铺" : user.shopScopes.length ? `${user.shopScopes.length} 家店铺` : "未授权店铺",
      wechat: channel?.externalUserId ?? null, active: user.active, lastPairedAt: channel?.pairedAt.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}

function unique(values: string[]) { return [...new Set(values)]; }
function required(value: string, code: string) { const normalized = value.trim(); if (!normalized) throw new Error(code); return normalized; }
