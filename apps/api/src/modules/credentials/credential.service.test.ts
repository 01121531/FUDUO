import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultCipher } from "@fuduo/credential-vault";
import { CredentialService } from "./credential.service.js";

function makeJwt(exp: number, iat?: number) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "fuduo-biz", sub: "725", exp, ...(iat === undefined ? {} : { iat }) })).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("CredentialService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("encrypts imported tokens and never returns plaintext", async () => {
    const service = new CredentialService();
    const token = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    const status = await service.importToken(token);
    expect(status).not.toHaveProperty("token");
    expect(status.status).toBe("ACTIVE");
    expect(service.getToken()).toBe(token);
  });

  it("rejects expired tokens", async () => {
    const service = new CredentialService();
    await expect(service.importToken(makeJwt(1))).rejects.toThrow("已过期");
  });

  it("does not rotate ciphertext or tokenVersion when the same token is uploaded again", async () => {
    const upsert = vi.fn(async (_input: { update: Record<string, unknown> }) => undefined);
    const service = new CredentialService({ enabled: true, prisma: { erpCredential: { upsert } } } as never);
    const token = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    await service.importToken(token);
    upsert.mockClear();

    await service.importToken(`Bearer ${token}`);

    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert.mock.calls[0]?.[0].update).not.toHaveProperty("tokenVersion");
    expect(service.getToken()).toBe(token);
  });

  it("does not let a slower concurrent verification overwrite a newer credential commit", async () => {
    const service = new CredentialService();
    const now = Math.floor(Date.now() / 1000);
    const first = service.importToken(makeJwt(now + 3_600, now));
    const staleConcurrent = service.importToken(makeJwt(now + 7_200, now + 1));

    await expect(first).resolves.toMatchObject({ status: "ACTIVE" });
    await expect(staleConcurrent).rejects.toThrow("ERP_CREDENTIAL_CHANGED_DURING_VERIFY");
  });

  it("rejects an older JWT for the same account", async () => {
    const service = new CredentialService();
    const now = Math.floor(Date.now() / 1000);
    await service.importToken(makeJwt(now + 7_200, now + 100));

    await expect(service.importToken(makeJwt(now + 3_600, now))).rejects.toThrow("ERP_CREDENTIAL_STALE_TOKEN");
  });

  it("reloads worker-side credential status changes from PostgreSQL", async () => {
    const encrypted = { accessTokenCipher: Buffer.from("cipher"), accessTokenIv: Buffer.alloc(12), accessTokenTag: Buffer.alloc(16) };
    const findUnique = vi.fn()
      .mockResolvedValueOnce({ status: "ACTIVE", tokenVersion: 1, expiresAt: new Date(Date.now() + 60_000), lastRefreshedAt: null, issuer: "fuduo-biz", subject: "725", accountName: "富多账号", shopCount: 8, ...encrypted })
      .mockResolvedValueOnce({ status: "REAUTH_REQUIRED", tokenVersion: 1, expiresAt: new Date(Date.now() + 60_000), lastRefreshedAt: null, issuer: "fuduo-biz", subject: "725", accountName: "富多账号", shopCount: 8, ...encrypted });
    const service = new CredentialService({ enabled: true, prisma: { erpCredential: { findUnique } } } as never);

    await expect(service.readStatus()).resolves.toMatchObject({ status: "ACTIVE", configured: true, accountName: "富多账号", shopCount: 8 });
    await expect(service.readStatus()).resolves.toMatchObject({ status: "REAUTH_REQUIRED", configured: true, accountName: "富多账号", shopCount: 8 });
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("recovers a stale REFRESHING state on API startup when the original token is valid", async () => {
    const vault = new VaultCipher(undefined, true);
    const token = makeJwt(Math.floor(Date.now() / 1000) + 3_600);
    const encrypted = vault.encrypt(token);
    const findUnique = vi.fn(async () => ({
      status: "REFRESHING",
      tokenVersion: 4,
      expiresAt: new Date(Date.now() + 3_600_000),
      lastRefreshedAt: null,
      issuer: "fuduo-biz",
      subject: "725",
      accountName: "富多账号",
      shopCount: 5,
      accessTokenCipher: encrypted.ciphertext,
      accessTokenIv: encrypted.iv,
      accessTokenTag: encrypted.tag,
      updatedAt: new Date(Date.now() - 60_000),
    }));
    const upsert = vi.fn(async () => undefined);
    const service = new CredentialService({ enabled: true, prisma: { erpCredential: { findUnique, upsert } } } as never);

    await service.onModuleInit();

    expect(service.getStatus()).toMatchObject({ status: "ACTIVE", configured: true, accountName: "富多账号", shopCount: 5 });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ status: "ACTIVE" }) }));
  });

  it("keeps a valid credential active after a transient manual refresh failure", async () => {
    const upsert = vi.fn(async (_input: { update: Record<string, unknown> }) => undefined);
    const service = new CredentialService({ enabled: true, prisma: { erpCredential: { upsert } } } as never);
    await service.importToken(makeJwt(Math.floor(Date.now() / 1000) + 3600));
    upsert.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: false,
      code: "UPSTREAM_BUSY",
      message: "busy",
    }), { status: 503, headers: { "Content-Type": "application/json" } })));

    await expect(service.refresh()).rejects.toMatchObject({ code: "UPSTREAM_BUSY" });

    expect(service.getStatus()).toMatchObject({ status: "ACTIVE", configured: true });
    expect(upsert).toHaveBeenCalledTimes(2);
    for (const [call] of upsert.mock.calls) {
      expect(call.update).not.toHaveProperty("tokenVersion");
    }
  });

  it("marks explicit authorization failures for reauthorization without changing tokenVersion", async () => {
    const upsert = vi.fn(async (_input: { update: Record<string, unknown> }) => undefined);
    const service = new CredentialService({ enabled: true, prisma: { erpCredential: { upsert } } } as never);
    await service.importToken(makeJwt(Math.floor(Date.now() / 1000) + 3600));
    upsert.mockClear();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: false,
      code: "BIZ_UNAUTHORIZED",
      message: "expired",
    }), { status: 401, headers: { "Content-Type": "application/json" } })));

    await expect(service.refresh()).rejects.toMatchObject({ code: "BIZ_UNAUTHORIZED" });

    expect(service.getStatus()).toMatchObject({ status: "REAUTH_REQUIRED", configured: true });
    expect(upsert).toHaveBeenCalledTimes(2);
    for (const [call] of upsert.mock.calls) {
      expect(call.update).not.toHaveProperty("tokenVersion");
    }
  });

  it("increments tokenVersion exactly once when refresh replaces the ciphertext", async () => {
    const upsert = vi.fn(async (_input: { update: Record<string, unknown> }) => undefined);
    const service = new CredentialService({ enabled: true, prisma: { erpCredential: { upsert } } } as never);
    await service.importToken(makeJwt(Math.floor(Date.now() / 1000) + 3600));
    upsert.mockClear();
    const nextToken = makeJwt(Math.floor(Date.now() / 1000) + 7200);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      success: true,
      data: { accessToken: nextToken },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(service.refresh()).resolves.toMatchObject({ status: "ACTIVE" });

    expect(service.getToken()).toBe(nextToken);
    const versionWrites = upsert.mock.calls.filter(([call]) => Object.hasOwn(call.update, "tokenVersion"));
    expect(versionWrites).toHaveLength(1);
    expect(versionWrites[0]?.[0].update.tokenVersion).toEqual({ increment: 1 });
  });
});
