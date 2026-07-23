import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialProvider } from "./credential-provider.js";
import { VaultCipher } from "@fuduo/credential-vault";

const originalKey = process.env.CREDENTIAL_MASTER_KEY_BASE64;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.CREDENTIAL_MASTER_KEY_BASE64;
  else process.env.CREDENTIAL_MASTER_KEY_BASE64 = originalKey;
});

describe("CredentialProvider reauthorization state", () => {
  it("notifies with the token version but preserves the original authorization error", async () => {
    process.env.CREDENTIAL_MASTER_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
    const onReauthRequired = vi.fn(async () => { throw new Error("alert unavailable"); });
    const prisma = {
      erpCredential: {
        findUnique: vi.fn(async () => ({ status: "REAUTH_REQUIRED", tokenVersion: 9 })),
      },
    };
    const provider = new CredentialProvider(prisma as never, {} as never, onReauthRequired);

    await expect(provider.getToken()).rejects.toThrow("ERP_REAUTH_REQUIRED");
    expect(onReauthRequired).toHaveBeenCalledWith(9);
  });

  it("waits through REFRESHING and returns the token written by the lock owner", async () => {
    process.env.CREDENTIAL_MASTER_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
    const vault = new VaultCipher(process.env.CREDENTIAL_MASTER_KEY_BASE64);
    const first = encryptedRow(vault, "first-token", 1, "REFRESHING");
    const second = encryptedRow(vault, "second-token", 2, "ACTIVE");
    const findUnique = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const redis = { set: vi.fn(async () => null) };
    const provider = new CredentialProvider({ erpCredential: { findUnique } } as never, redis as never);

    await expect(provider.refresh()).resolves.toBe("second-token");
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("restores ACTIVE after a transient refresh failure", async () => {
    process.env.CREDENTIAL_MASTER_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
    const vault = new VaultCipher(process.env.CREDENTIAL_MASTER_KEY_BASE64);
    const stored = encryptedRow(vault, "current-token", 4, "ACTIVE");
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      erpCredential: {
        findUnique: vi.fn(async () => stored),
        update: vi.fn(async () => stored),
        updateMany,
      },
    };
    const redis = { set: vi.fn(async () => "OK"), eval: vi.fn(async () => 1) };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false, code: "UPSTREAM_BUSY", message: "busy" }), { status: 502 })));
    const provider = new CredentialProvider(prisma as never, redis as never);

    await expect(provider.refresh()).rejects.toMatchObject({ code: "UPSTREAM_BUSY" });
    expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { singletonKey: "primary", tokenVersion: 4, status: "REFRESHING" },
      data: expect.objectContaining({ status: "ACTIVE", lastErrorCode: "UPSTREAM_BUSY" }),
    }));
  });

  it("recovers an abandoned REFRESHING row after its lease window", async () => {
    process.env.CREDENTIAL_MASTER_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");
    const vault = new VaultCipher(process.env.CREDENTIAL_MASTER_KEY_BASE64);
    const now = Math.floor(Date.now() / 1000);
    const token = makeJwt(now + 3_600);
    const refreshing = { ...encryptedRow(vault, token, 5, "REFRESHING"), updatedAt: new Date(Date.now() - 60_000) };
    const active = { ...refreshing, status: "ACTIVE", updatedAt: new Date() };
    const findUnique = vi.fn().mockResolvedValueOnce(refreshing).mockResolvedValueOnce(active);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const provider = new CredentialProvider({ erpCredential: { findUnique, updateMany } } as never, {} as never);

    await expect(provider.getToken()).resolves.toBe(token);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "credential-1", status: "REFRESHING", tokenVersion: 5 }),
      data: expect.objectContaining({ status: "ACTIVE", lastErrorCode: "ERP_REFRESH_INTERRUPTED" }),
    }));
  });
});

function encryptedRow(vault: VaultCipher, token: string, tokenVersion: number, status: string) {
  const encrypted = vault.encrypt(token);
  return {
    id: "credential-1",
    singletonKey: "primary",
    status,
    tokenVersion,
    accessTokenCipher: encrypted.ciphertext,
    accessTokenIv: encrypted.iv,
    accessTokenTag: encrypted.tag,
    updatedAt: new Date(),
  };
}

function makeJwt(exp: number) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: "fuduo-biz", sub: "725", exp })).toString("base64url");
  return `${header}.${payload}.signature`;
}
