import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { DatabaseService } from "../database/database.service.js";

export const BUILT_IN_ROLES = [
  { code: "ADMIN", name: "管理员", permissions: ["*"] },
  { code: "OPERATOR", name: "经营人员", permissions: ["data:read", "sync:run", "chat:use", "reports:read", "reports:generate"] },
  { code: "VIEWER", name: "只读人员", permissions: ["data:read", "chat:use", "reports:read"] },
] as const;

export interface UserAccessScope {
  userId: string;
  permissions: string[];
  allShops: boolean;
  shopIds: string[];
}

@Injectable()
export class AccessControlService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async ensureBuiltInRoles() {
    if (!this.database.enabled) return BUILT_IN_ROLES.map((role, index) => ({ id: `demo-role-${index}`, ...role }));
    return Promise.all(BUILT_IN_ROLES.map((role) => this.database.prisma.role.upsert({
      where: { code: role.code },
      create: { code: role.code, name: role.name, permissions: [...role.permissions] },
      update: { name: role.name, permissions: [...role.permissions] },
    })));
  }

  async scope(userId?: string): Promise<UserAccessScope> {
    if (!this.database.enabled) return { userId: userId ?? "demo-user", permissions: ["*"], allShops: true, shopIds: [] };
    if (!userId) throw new UnauthorizedException("请先登录");
    const user = await this.database.prisma.user.findUnique({
      where: { id: userId },
      include: { userRoles: { include: { role: true } }, shopScopes: { include: { shop: true } } },
    });
    if (!user?.active) throw new UnauthorizedException("登录账号已停用");
    const permissions = [...new Set(user.userRoles.flatMap((entry) => entry.role.permissions))];
    return {
      userId,
      permissions,
      allShops: permissions.includes("*"),
      shopIds: user.shopScopes.filter((entry) => entry.shop.status !== "ARCHIVED").map((entry) => String(entry.shop.fuduoShopId)),
    };
  }

  async assertPermission(userId: string | undefined, permission: string) {
    const scope = await this.scope(userId);
    if (!scope.permissions.includes("*") && !scope.permissions.includes(permission)) {
      throw new ForbiddenException("当前账号没有此功能权限");
    }
    return scope;
  }

  async readableShopIds(userId: string | undefined, requested: string[] = []): Promise<string[] | null> {
    const scope = await this.assertPermission(userId, "data:read");
    if (scope.allShops) return requested.length ? requested : null;
    const allowed = new Set(scope.shopIds);
    if (requested.some((id) => !allowed.has(id))) throw new ForbiddenException("请求包含无权查看的店铺");
    return requested.length ? requested : scope.shopIds;
  }

  async assertReadableShop(userId: string | undefined, shopId: string) {
    const allowed = await this.readableShopIds(userId, [shopId]);
    return allowed?.includes(shopId) ?? true;
  }

  async resolveChannelUser(externalUserId?: string) {
    if (!this.database.enabled) return undefined;
    const normalized = externalUserId?.trim();
    if (!normalized || normalized.length > 256) throw new Error("CHANNEL_USER_ID_REQUIRED");
    const pairing = await this.database.prisma.channelUser.findFirst({
      where: {
        externalUserId: normalized,
        revokedAt: null,
        user: { active: true },
        channelAccount: { channel: "openclaw-weixin", active: true },
      },
      select: { userId: true },
    });
    if (!pairing) throw new Error("CHANNEL_USER_NOT_PAIRED");
    return pairing.userId;
  }
}
