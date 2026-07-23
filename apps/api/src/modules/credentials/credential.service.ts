import { Inject, Injectable, Optional, type OnModuleInit } from "@nestjs/common";
import { normalizeAuthorization, parseJwtClaims, VaultCipher, type EncryptedPayload } from "@fuduo/credential-vault";
import { FuduoApiError, FuduoClient } from "@fuduo/fuduo-sdk";
import type { CredentialStatus } from "@fuduo/shared";
import { DatabaseService } from "../database/database.service.js";

const IDENTITY_MISMATCH_MESSAGE = "刷新后的 Authorization 账号与当前账号不一致";

@Injectable()
export class CredentialService implements OnModuleInit {
  private encrypted: EncryptedPayload | null = null;
  private status: CredentialStatus = "UNCONFIGURED";
  private expiresAt: string | null = null;
  private lastRefreshedAt: string | null = null;
  private issuer: string | null = null;
  private subject: string | null = null;
  private accountName: string | null = null;
  private shopCount: number | null = null;
  private refreshInFlight: Promise<ReturnType<CredentialService["getStatus"]>> | null = null;
  private mutationTail = Promise.resolve();
  private mutationRevision = 0;
  private readonly vault: VaultCipher;

  constructor(@Optional() @Inject(DatabaseService) private readonly database?: DatabaseService) {
    this.vault = new VaultCipher(process.env.CREDENTIAL_MASTER_KEY_BASE64, process.env.DEMO_MODE !== "false");
  }

  async onModuleInit() {
    if (!this.database?.enabled) return;
    await this.reloadFromDatabase(true);
  }

  getStatus() {
    return {
      status: this.status,
      expiresAt: this.expiresAt,
      lastRefreshedAt: this.lastRefreshedAt,
      configured: this.encrypted !== null,
      issuer: this.issuer,
      subject: this.subject,
      accountName: this.accountName,
      shopCount: this.shopCount,
      storage: this.database?.enabled ? "AES-256-GCM / PostgreSQL" : "AES-256-GCM memory vault (demo)",
    };
  }

  async readStatus() {
    return this.withMutation(async () => {
      if (this.database?.enabled) await this.reloadFromDatabase(false);
      return this.getStatus();
    });
  }

  async importToken(tokenInput: string, verify = false) {
    const expectedRevision = this.mutationRevision;
    const token = normalizeAuthorization(tokenInput);
    const claims = parseJwtClaims(token);
    if (!claims) throw new Error("Authorization 不是有效 JWT");
    if (claims.exp * 1000 <= Date.now()) throw new Error("Authorization 已过期");

    // A session refresh does not return account metadata. Keep the last verified
    // identity until a verified import supplies a newer snapshot.
    let accountName = this.accountName;
    let shopCount = this.shopCount;
    if (verify) {
      const client = new FuduoClient({ getAccessToken: () => token });
      const [me, shops] = await Promise.all([client.getMe(), client.listVisibleShops(1, 100)]);
      accountName = me.name ?? me.nickname ?? null;
      shopCount = shops.total ?? shops.records.length;
    }

    return this.withMutation(async () => {
      const current = this.getToken();
      if (this.mutationRevision !== expectedRevision && current !== token) {
        throw new Error("ERP_CREDENTIAL_CHANGED_DURING_VERIFY");
      }
      rejectOlderToken(current, token);
      await this.commitToken(token, claims, accountName, shopCount);
      return this.getStatus();
    });
  }

  async refresh() {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.performRefresh();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async performRefresh() {
    return this.withMutation(async () => {
      const current = this.getToken();
      if (!current) throw new Error("富多授权尚未配置");
      this.status = "REFRESHING";
      await this.persist();
      try {
        const client = new FuduoClient();
        const next = await client.refreshSession(current);
        const claims = parseJwtClaims(next);
        const nextIssuer = claims?.iss ?? null;
        const nextSubject = claims?.subject ?? null;
        if (!claims || (this.issuer && nextIssuer !== this.issuer) || (this.subject && nextSubject !== this.subject)) {
          throw new Error(IDENTITY_MISMATCH_MESSAGE);
        }
        rejectOlderToken(current, next);
        await this.commitToken(next, claims, this.accountName, this.shopCount);
        this.lastRefreshedAt = new Date().toISOString();
        await this.persist();
        return { ...this.getStatus(), lastRefreshedAt: this.lastRefreshedAt };
      } catch (error) {
        this.status = isTerminalCredentialError(error) ? "REAUTH_REQUIRED" : "ACTIVE";
        await this.persist(error);
        throw error;
      }
    });
  }

  async revoke() {
    return this.withMutation(async () => {
      this.encrypted = null;
      this.status = "REVOKED";
      this.expiresAt = null;
      this.issuer = null;
      this.subject = null;
      this.accountName = null;
      this.shopCount = null;
      this.mutationRevision += 1;
      await this.persist();
      return this.getStatus();
    });
  }

  getToken(): string | null {
    if (!this.encrypted) return null;
    return this.vault.decrypt(this.encrypted);
  }

  private async reloadFromDatabase(recoverInterruptedRefresh: boolean) {
    if (!this.database?.enabled) return;
    const stored = await this.database.prisma.erpCredential.findUnique({ where: { singletonKey: "primary" } });
    if (!stored) {
      this.encrypted = null;
      this.status = "UNCONFIGURED";
      this.expiresAt = null;
      this.lastRefreshedAt = null;
      this.issuer = null;
      this.subject = null;
      this.accountName = null;
      this.shopCount = null;
      return;
    }

    this.status = stored.status;
    this.expiresAt = stored.expiresAt?.toISOString() ?? null;
    this.lastRefreshedAt = stored.lastRefreshedAt?.toISOString() ?? null;
    this.issuer = stored.issuer;
    this.subject = stored.subject;
    this.accountName = stored.accountName;
    this.shopCount = stored.shopCount;
    this.encrypted = stored.accessTokenCipher && stored.accessTokenIv && stored.accessTokenTag
      ? {
          ciphertext: Buffer.from(stored.accessTokenCipher),
          iv: Buffer.from(stored.accessTokenIv),
          tag: Buffer.from(stored.accessTokenTag),
        }
      : null;

    if (recoverInterruptedRefresh && stored.status === "REFRESHING" && Date.now() - stored.updatedAt.getTime() > 45_000) {
      if (this.encrypted && stored.expiresAt && stored.expiresAt.getTime() > Date.now()) {
        this.status = "ACTIVE";
        await this.persist(new Error("上次 Authorization 刷新因服务重启中断，已恢复原凭证"));
      } else {
        this.encrypted = null;
        this.status = "REAUTH_REQUIRED";
        await this.persist(new Error("Authorization 刷新中断且原凭证已失效，请重新扫码授权"));
      }
    }

    if (stored.status === "ACTIVE" && stored.expiresAt && stored.expiresAt.getTime() <= Date.now()) {
      this.encrypted = null;
      this.status = "REAUTH_REQUIRED";
      await this.persist(new Error("Authorization 已过期，请重新扫码授权"));
    }
  }

  private async commitToken(
    token: string,
    claims: NonNullable<ReturnType<typeof parseJwtClaims>>,
    accountName: string | null,
    shopCount: number | null,
  ) {
    const tokenChanged = this.getToken() !== token;
    if (tokenChanged) this.encrypted = this.vault.encrypt(token);
    this.status = "ACTIVE";
    this.expiresAt = new Date(claims.exp * 1000).toISOString();
    this.issuer = claims.iss;
    this.subject = claims.subject;
    this.accountName = accountName;
    this.shopCount = shopCount;
    if (tokenChanged) this.mutationRevision += 1;
    await this.persist(undefined, tokenChanged);
  }

  private async withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async persist(error?: unknown, tokenChanged = false) {
    if (!this.database?.enabled) return;
    const encrypted = this.encrypted;
    const errorMessage = error instanceof Error ? error.message.slice(0, 500) : null;
    await this.database.prisma.erpCredential.upsert({
      where: { singletonKey: "primary" },
      create: {
        singletonKey: "primary",
        status: this.status,
        issuer: this.issuer,
        subject: this.subject,
        accountName: this.accountName,
        shopCount: this.shopCount,
        accessTokenCipher: encrypted ? toDatabaseBytes(encrypted.ciphertext) : null,
        accessTokenIv: encrypted ? toDatabaseBytes(encrypted.iv) : null,
        accessTokenTag: encrypted ? toDatabaseBytes(encrypted.tag) : null,
        tokenVersion: encrypted ? 1 : 0,
        expiresAt: this.expiresAt ? new Date(this.expiresAt) : null,
        lastRefreshedAt: this.lastRefreshedAt ? new Date(this.lastRefreshedAt) : null,
        lastErrorMessage: errorMessage,
      },
      update: {
        status: this.status,
        issuer: this.issuer,
        subject: this.subject,
        accountName: this.accountName,
        shopCount: this.shopCount,
        accessTokenCipher: encrypted ? toDatabaseBytes(encrypted.ciphertext) : null,
        accessTokenIv: encrypted ? toDatabaseBytes(encrypted.iv) : null,
        accessTokenTag: encrypted ? toDatabaseBytes(encrypted.tag) : null,
        ...(tokenChanged ? { tokenVersion: { increment: 1 } } : {}),
        expiresAt: this.expiresAt ? new Date(this.expiresAt) : null,
        lastRefreshedAt: this.lastRefreshedAt ? new Date(this.lastRefreshedAt) : null,
        lastErrorMessage: errorMessage,
      },
    });
  }
}

function rejectOlderToken(current: string | null, next: string) {
  if (!current || current === next) return;
  const currentClaims = parseJwtClaims(current);
  const nextClaims = parseJwtClaims(next);
  if (!currentClaims || !nextClaims || currentClaims.iss !== nextClaims.iss || currentClaims.subject !== nextClaims.subject) return;
  const currentIssuedAt = typeof currentClaims.raw.iat === "number" ? currentClaims.raw.iat : null;
  const nextIssuedAt = typeof nextClaims.raw.iat === "number" ? nextClaims.raw.iat : null;
  if (currentIssuedAt !== null && nextIssuedAt !== null && nextIssuedAt < currentIssuedAt) {
    throw new Error("ERP_CREDENTIAL_STALE_TOKEN");
  }
}

function isTerminalCredentialError(error: unknown) {
  if (error instanceof Error && error.message === IDENTITY_MISMATCH_MESSAGE) return true;
  return error instanceof FuduoApiError
    && (error.status === 401 || error.code === "BIZ_UNAUTHORIZED" || error.code === "ERP_TOKEN_MISSING");
}

function toDatabaseBytes(value: Buffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(value.length);
  bytes.set(value);
  return bytes;
}
