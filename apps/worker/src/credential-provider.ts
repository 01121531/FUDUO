import { randomUUID } from "node:crypto";
import { VaultCipher, parseJwtClaims, shouldRefreshJwt } from "@fuduo/credential-vault";
import type { PrismaClient } from "@fuduo/database";
import { FuduoApiError, FuduoClient } from "@fuduo/fuduo-sdk";
import type Redis from "ioredis";

export class CredentialProvider {
  private readonly vault: VaultCipher;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
    private readonly onReauthRequired: (credentialVersion: number) => Promise<unknown> = async () => undefined,
  ) {
    this.vault = new VaultCipher(process.env.CREDENTIAL_MASTER_KEY_BASE64);
  }

  async getToken(): Promise<string> {
    const stored = await this.load();
    const token = this.decrypt(stored);
    if (shouldRefreshJwt(token)) return this.refresh();
    return token;
  }

  async refreshIfNeeded(): Promise<boolean> {
    const stored = await this.load();
    const token = this.decrypt(stored);
    if (!shouldRefreshJwt(token)) return false;
    await this.refresh();
    return true;
  }

  async refresh(): Promise<string> {
    const lockKey = "credential-refresh:primary";
    const lockValue = randomUUID();
    const acquired = await this.redis.set(lockKey, lockValue, "PX", 30_000, "NX");
    if (!acquired) {
      const before = await this.loadRefreshState();
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await delay(250);
        const current = await this.loadRefreshState();
        if (current.tokenVersion !== before.tokenVersion && current.status === "ACTIVE") return this.decrypt(current);
        if (current.status === "REAUTH_REQUIRED") throw new Error("ERP_REAUTH_REQUIRED");
      }
      throw new Error("ERP_REFRESH_LOCK_TIMEOUT");
    }

    let credentialVersion: number | null = null;
    try {
      const stored = await this.load();
      credentialVersion = stored.tokenVersion;
      const current = this.decrypt(stored);
      await this.prisma.erpCredential.update({
        where: { singletonKey: "primary" },
        data: { status: "REFRESHING", lastErrorCode: null, lastErrorMessage: null },
      });
      const next = await new FuduoClient().refreshSession(current);
      const currentClaims = parseJwtClaims(current);
      const nextClaims = parseJwtClaims(next);
      if (!nextClaims || currentClaims?.iss !== nextClaims.iss || currentClaims?.subject !== nextClaims.subject) {
        throw new Error("ERP_REFRESH_IDENTITY_MISMATCH");
      }
      const encrypted = this.vault.encrypt(next);
      const updated = await this.prisma.erpCredential.updateMany({
        where: { id: stored.id, tokenVersion: stored.tokenVersion },
        data: {
          status: "ACTIVE",
          accessTokenCipher: bytes(encrypted.ciphertext),
          accessTokenIv: bytes(encrypted.iv),
          accessTokenTag: bytes(encrypted.tag),
          tokenVersion: { increment: 1 },
          expiresAt: new Date(nextClaims.exp * 1000),
          lastRefreshedAt: new Date(),
        },
      });
      if (updated.count !== 1) return this.getToken();
      return next;
    } catch (error) {
      if (credentialVersion === null) throw error;
      const terminal = isTerminalCredentialError(error);
      const updated = await this.prisma.erpCredential.updateMany({
        where: { singletonKey: "primary", tokenVersion: credentialVersion, status: "REFRESHING" },
        data: {
          status: terminal ? "REAUTH_REQUIRED" : "ACTIVE",
          lastErrorCode: errorCode(error),
          lastErrorMessage: terminal ? "富多授权刷新失败，请重新扫码授权" : "富多授权刷新暂时失败，系统稍后重试",
        },
      });
      if (updated.count === 0) return this.getToken();
      if (terminal) await this.notifyReauthRequired(credentialVersion);
      throw error;
    } finally {
      await this.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        lockKey,
        lockValue,
      ).catch(() => undefined);
    }
  }

  private async load() {
    let stored = await this.prisma.erpCredential.findUnique({ where: { singletonKey: "primary" } });
    if (stored?.status === "REFRESHING") {
      if (Date.now() - stored.updatedAt.getTime() <= 45_000) throw new Error("ERP_REFRESH_IN_PROGRESS");
      const hasCipher = Boolean(stored.accessTokenCipher && stored.accessTokenIv && stored.accessTokenTag);
      let originalStillValid = false;
      if (hasCipher) {
        try {
          const claims = parseJwtClaims(this.decrypt(stored));
          originalStillValid = Boolean(claims && claims.exp * 1000 > Date.now());
        } catch {
          originalStillValid = false;
        }
      }
      await this.prisma.erpCredential.updateMany({
        where: { id: stored.id, status: "REFRESHING", tokenVersion: stored.tokenVersion, updatedAt: stored.updatedAt },
        data: {
          status: originalStillValid ? "ACTIVE" : "REAUTH_REQUIRED",
          lastErrorCode: "ERP_REFRESH_INTERRUPTED",
          lastErrorMessage: originalStillValid
            ? "上次 Authorization 刷新中断，已恢复原凭证"
            : "Authorization 刷新中断且原凭证已失效，请重新扫码授权",
        },
      });
      stored = await this.prisma.erpCredential.findUnique({ where: { singletonKey: "primary" } });
    }
    if (!stored || stored.status !== "ACTIVE" || !stored.accessTokenCipher || !stored.accessTokenIv || !stored.accessTokenTag) {
      if (stored?.status === "REAUTH_REQUIRED") await this.notifyReauthRequired(stored.tokenVersion);
      throw new Error("ERP_REAUTH_REQUIRED");
    }
    return stored;
  }

  private async loadRefreshState() {
    const stored = await this.prisma.erpCredential.findUnique({ where: { singletonKey: "primary" } });
    if (!stored || !stored.accessTokenCipher || !stored.accessTokenIv || !stored.accessTokenTag) throw new Error("ERP_REAUTH_REQUIRED");
    return stored;
  }

  private decrypt(stored: Awaited<ReturnType<CredentialProvider["load"]>>): string {
    return this.vault.decrypt({
      ciphertext: Buffer.from(stored.accessTokenCipher!),
      iv: Buffer.from(stored.accessTokenIv!),
      tag: Buffer.from(stored.accessTokenTag!),
    });
  }

  private async notifyReauthRequired(credentialVersion: number) {
    await this.onReauthRequired(credentialVersion).catch(() => undefined);
  }
}

function bytes(value: Buffer): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(value.length);
  result.set(value);
  return result;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminalCredentialError(error: unknown) {
  if (error instanceof Error && error.message === "ERP_REFRESH_IDENTITY_MISMATCH") return true;
  return error instanceof FuduoApiError && (error.status === 401 || error.code === "BIZ_UNAUTHORIZED" || error.code === "ERP_TOKEN_MISSING");
}

function errorCode(error: unknown) {
  if (error instanceof FuduoApiError) return error.code.slice(0, 80);
  return error instanceof Error ? error.message.slice(0, 80) : "ERP_REFRESH_FAILED";
}
