import { describe, expect, it, vi } from "vitest";
import { AuthService, generateTotpCode, hashPassword, verifyPassword, verifyTotp } from "./auth.service.js";

describe("internal authentication", () => {
  it("hashes passwords with a random scrypt salt", () => {
    const first = hashPassword("correct horse battery staple");
    const second = hashPassword("correct horse battery staple");
    expect(first).not.toBe(second);
    expect(verifyPassword("correct horse battery staple", first)).toBe(true);
    expect(verifyPassword("incorrect", first)).toBe(false);
  });

  it("validates RFC 6238 compatible six digit TOTP codes with a one-step window", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(verifyTotp(secret, "287082", 59_000)).toBe(true);
    expect(verifyTotp(secret, "000000", 59_000)).toBe(false);
  });

  it("completes an expiring TOTP enrollment in demo mode", async () => {
    const service = new AuthService({ enabled: false } as never);
    const setup = await service.beginTotpEnrollment(undefined, "demo-password");

    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.otpauthUri).toContain(`secret=${setup.secret}`);
    expect(setup.otpauthUri).toContain(":admin%40example.com?");
    await expect(service.confirmTotpEnrollment(undefined, undefined, setup.enrollmentId, "000000")).rejects.toThrow("AUTH_TOTP_INVALID");
    await expect(service.confirmTotpEnrollment(undefined, undefined, setup.enrollmentId, generateTotpCode(setup.secret))).resolves.toMatchObject({ totpEnabled: true, demo: true });
    await expect(service.securityStatus()).resolves.toMatchObject({ totpEnabled: true });
  });

  it("invalidates a cancelled TOTP enrollment immediately", async () => {
    const service = new AuthService({ enabled: false } as never);
    const setup = await service.beginTotpEnrollment(undefined, "demo-password");
    await expect(service.cancelTotpEnrollment(undefined, setup.enrollmentId)).resolves.toEqual({ cancelled: true });
    await expect(service.confirmTotpEnrollment(undefined, undefined, setup.enrollmentId, generateTotpCode(setup.secret))).rejects.toThrow("AUTH_TOTP_ENROLLMENT_EXPIRED");
  });

  it("encrypts a production enrollment and atomically rotates TOTP with session revocation and audit", async () => {
    const passwordHash = hashPassword("current-password");
    const user = { id: "11111111-1111-4111-8111-111111111111", email: "admin@example.com", active: true, passwordHash, totpEnabled: false, totpSecretCipher: null, totpSecretIv: null, totpSecretTag: null };
    let stored: { secretCipher: Uint8Array; secretIv: Uint8Array; secretTag: Uint8Array; expiresAt: Date } | null = null;
    const userUpdate = vi.fn();
    const sessionUpdate = vi.fn();
    const currentSessionUpdate = vi.fn();
    const auditCreate = vi.fn();
    const enrollmentDelete = vi.fn();
    const prisma = {
      user: { findUnique: vi.fn(async () => user) },
      totpEnrollment: {
        upsert: vi.fn(async ({ create }: { create: typeof stored }) => { stored = create; return { id: "22222222-2222-4222-8222-222222222222" }; }),
        findFirst: vi.fn(async () => stored ? { id: "22222222-2222-4222-8222-222222222222", userId: user.id, ...stored, attempts: 0, user } : null),
        update: vi.fn(async () => ({})),
      },
      $transaction: async (operation: (transaction: unknown) => Promise<void>) => operation({
        user: { update: userUpdate },
        totpEnrollment: { delete: enrollmentDelete },
        userSession: { updateMany: sessionUpdate, update: currentSessionUpdate },
        auditLog: { create: auditCreate },
      }),
    };
    const service = new AuthService({ enabled: true, prisma } as never);
    const setup = await service.beginTotpEnrollment(user.id, "current-password");
    const code = generateTotpCode(setup.secret);

    expect(Buffer.from(stored!.secretCipher).toString("utf8")).not.toContain(setup.secret);
    await service.confirmTotpEnrollment(user.id, "33333333-3333-4333-8333-333333333333", setup.enrollmentId, code);

    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ totpEnabled: true }) }));
    expect(sessionUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { not: "33333333-3333-4333-8333-333333333333" } }) }));
    expect(currentSessionUpdate).toHaveBeenCalledWith({ where: { id: "33333333-3333-4333-8333-333333333333" }, data: { state: "ACTIVE", attempts: 0 } });
    expect(enrollmentDelete).toHaveBeenCalledOnce();
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "启用 TOTP", result: "SUCCEEDED" }) }));
  });

  it("creates only a password-change session for a temporary-password user", async () => {
    const passwordHash = hashPassword("temporary-password-123");
    const create = vi.fn(async () => ({ id: "session-1" }));
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ id: "user-1", active: true, passwordHash, totpEnabled: false, mustChangePassword: true })) },
      userSession: { create },
    };
    const service = new AuthService({ enabled: true, prisma } as never);

    await expect(service.passwordLogin("user@example.com", "temporary-password-123")).resolves.toMatchObject({
      requiresTotp: false,
      nextAction: "CHANGE_PASSWORD",
      session: { token: expect.any(String), expiresAt: expect.any(Date) },
    });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "user-1", state: "PASSWORD_CHANGE_REQUIRED" }) });
  });

  it("moves a password-change session to mandatory TOTP enrollment", async () => {
    const passwordHash = hashPassword("temporary-password-123");
    const userUpdate = vi.fn();
    const otherSessionsUpdate = vi.fn();
    const currentSessionUpdate = vi.fn();
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ id: "user-1", email: "user@example.com", active: true, passwordHash, totpEnabled: false })) },
      $transaction: async (operation: (transaction: unknown) => Promise<void>) => operation({
        user: { update: userUpdate },
        userSession: { updateMany: otherSessionsUpdate, update: currentSessionUpdate },
        auditLog: { create: vi.fn() },
      }),
    };
    const service = new AuthService({ enabled: true, prisma } as never);

    await expect(service.changePassword("user-1", "session-1", "temporary-password-123", "new-password-456789")).resolves.toMatchObject({
      changed: true,
      nextAction: "TOTP_ENROLL",
    });
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ mustChangePassword: false }) }));
    expect(currentSessionUpdate).toHaveBeenCalledWith({ where: { id: "session-1" }, data: { state: "TOTP_ENROLLMENT_REQUIRED", attempts: 0 } });
    expect(otherSessionsUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { not: "session-1" } }) }));
  });

  it("completes the temporary password to TOTP enrollment state machine", async () => {
    const user = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "operator@example.com",
      displayName: "经营同事",
      active: true,
      passwordHash: hashPassword("temporary-password-123"),
      mustChangePassword: true,
      totpEnabled: false,
      totpSecretCipher: null as Uint8Array | null,
      totpSecretIv: null as Uint8Array | null,
      totpSecretTag: null as Uint8Array | null,
    };
    const sessions: Array<Record<string, unknown>> = [];
    let enrollment: Record<string, unknown> | null = null;
    const userSession = {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: "22222222-2222-4222-8222-222222222222", attempts: 0, revokedAt: null, ...data };
        sessions.push(created);
        return created;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const session = sessions.find((entry) => entry.id === where.id)!;
        Object.assign(session, data);
        return session;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: { userId: string; id?: { not: string } }; data: Record<string, unknown> }) => {
        const targets = sessions.filter((entry) => entry.userId === where.userId && (!where.id || entry.id !== where.id.not));
        targets.forEach((entry) => Object.assign(entry, data));
        return { count: targets.length };
      }),
    };
    const prisma = {
      user: {
        findUnique: vi.fn(async () => user),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { Object.assign(user, data); return user; }),
      },
      userSession,
      totpEnrollment: {
        upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
          enrollment = { id: "33333333-3333-4333-8333-333333333333", attempts: 0, ...create };
          return enrollment;
        }),
        findFirst: vi.fn(async () => enrollment ? { ...enrollment, user } : null),
        update: vi.fn(async () => enrollment),
        delete: vi.fn(async () => { enrollment = null; }),
      },
      auditLog: { create: vi.fn(async () => ({})) },
      $transaction: async (operation: (transaction: unknown) => Promise<void>) => operation(prisma),
    };
    const service = new AuthService({ enabled: true, prisma } as never);

    const login = await service.passwordLogin(user.email, "temporary-password-123");
    expect(login).toMatchObject({ nextAction: "CHANGE_PASSWORD" });
    expect(sessions[0]).toMatchObject({ state: "PASSWORD_CHANGE_REQUIRED" });

    await expect(service.changePassword(user.id, String(sessions[0]!.id), "temporary-password-123", "new-password-456789"))
      .resolves.toMatchObject({ nextAction: "TOTP_ENROLL" });
    expect(user.mustChangePassword).toBe(false);
    expect(sessions[0]).toMatchObject({ state: "TOTP_ENROLLMENT_REQUIRED" });

    const setup = await service.beginTotpEnrollment(user.id, "new-password-456789");
    await expect(service.confirmTotpEnrollment(user.id, String(sessions[0]!.id), setup.enrollmentId, generateTotpCode(setup.secret)))
      .resolves.toMatchObject({ totpEnabled: true });
    expect(user.totpEnabled).toBe(true);
    expect(sessions[0]).toMatchObject({ state: "ACTIVE" });
    expect(enrollment).toBeNull();
  }, 15_000);

  it("keeps a reset user in password change after a valid TOTP challenge", async () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    const vault = new AuthService({ enabled: false } as never) as unknown as { vault: { encrypt(value: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } } };
    const encrypted = vault.vault.encrypt(secret);
    const user = {
      id: "user-1", email: "operator@example.com", displayName: "经营同事", active: true,
      mustChangePassword: true, totpEnabled: true,
      totpSecretCipher: encrypted.ciphertext, totpSecretIv: encrypted.iv, totpSecretTag: encrypted.tag,
    };
    const update = vi.fn(async () => ({}));
    const prisma = {
      userSession: {
        findUnique: vi.fn(async () => ({
          id: "challenge-1", state: "TOTP_REQUIRED", revokedAt: null, expiresAt: new Date(Date.now() + 60_000), attempts: 0, user,
        })),
        update,
      },
    };
    const service = new AuthService({ enabled: true, prisma } as never);

    await expect(service.verifyTotp("challenge-token", generateTotpCode(secret))).resolves.toMatchObject({ nextAction: "CHANGE_PASSWORD" });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: "PASSWORD_CHANGE_REQUIRED" }) }));
  });
});
