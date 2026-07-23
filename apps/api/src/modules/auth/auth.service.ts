import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { Inject, Injectable, Optional, type OnModuleInit } from "@nestjs/common";
import { VaultCipher } from "@fuduo/credential-vault";
import { DatabaseService } from "../database/database.service.js";
import { hashToken } from "./auth.guard.js";
import { AccessControlService, BUILT_IN_ROLES } from "./access-control.service.js";
import type { AuthSessionState } from "@fuduo/database";

interface DemoEnrollment { id: string; secret: string; expiresAt: number; attempts: number }

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly vault: VaultCipher;
  private demoEnrollment: DemoEnrollment | null = null;
  private demoTotpEnabled = false;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Optional() @Inject(AccessControlService) private readonly access?: AccessControlService,
  ) {
    this.vault = new VaultCipher(process.env.CREDENTIAL_MASTER_KEY_BASE64, process.env.DEMO_MODE === "true");
  }

  async onModuleInit() {
    if (!this.database.enabled) return;
    const roles = this.access
      ? await this.access.ensureBuiltInRoles()
      : await Promise.all(BUILT_IN_ROLES.map((role) => this.database.prisma.role.upsert({
          where: { code: role.code },
          create: { code: role.code, name: role.name, permissions: [...role.permissions] },
          update: { name: role.name, permissions: [...role.permissions] },
        })));
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const totpSecret = process.env.BOOTSTRAP_ADMIN_TOTP_SECRET_BASE32;
    if (!email || !password || !totpSecret) return;
    const existing = await this.database.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (existing) return;
    const encrypted = this.vault.encrypt(totpSecret.replace(/\s+/g, "").toUpperCase());
    const role = roles.find((entry) => entry.code === "ADMIN");
    if (!role) throw new Error("AUTH_ADMIN_ROLE_MISSING");
    await this.database.prisma.user.create({
      data: {
        email: email.toLowerCase(),
        displayName: "管理员",
        passwordHash: hashPassword(password),
        totpEnabled: true,
        totpSecretCipher: bytes(encrypted.ciphertext),
        totpSecretIv: bytes(encrypted.iv),
        totpSecretTag: bytes(encrypted.tag),
        userRoles: { create: { roleId: role.id } },
      },
    });
  }

  async passwordLogin(email: string, password: string) {
    if (!this.database.enabled) return { requiresTotp: false, nextAction: "NONE" as const, demo: true };
    const user = await this.database.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !user.active || !verifyPassword(password, user.passwordHash)) {
      await delay(250);
      throw new Error("AUTH_INVALID_CREDENTIALS");
    }
    if (!user.totpEnabled) {
      const state: AuthSessionState = user.mustChangePassword ? "PASSWORD_CHANGE_REQUIRED" : "TOTP_ENROLLMENT_REQUIRED";
      return { requiresTotp: false, nextAction: nextAction(state), session: await this.createSession(user.id, state) };
    }
    const challenge = await this.createSession(user.id, "TOTP_REQUIRED", 5 * 60_000);
    return { requiresTotp: true, nextAction: "TOTP_VERIFY" as const, challengeId: challenge.token, expiresAt: challenge.expiresAt.toISOString() };
  }

  async verifyTotp(challengeId: string, code: string) {
    const challenge = await this.database.prisma.userSession.findUnique({
      where: { tokenHash: hashToken(challengeId) },
      include: { user: true },
    });
    if (!challenge || challenge.state !== "TOTP_REQUIRED" || challenge.revokedAt || challenge.expiresAt.getTime() <= Date.now() || challenge.attempts >= 5 || !challenge.user.active) {
      if (challenge) await this.database.prisma.userSession.update({ where: { id: challenge.id }, data: { revokedAt: new Date() } }).catch(() => undefined);
      throw new Error("AUTH_CHALLENGE_EXPIRED");
    }
    await this.database.prisma.userSession.update({ where: { id: challenge.id }, data: { attempts: { increment: 1 } } });
    const user = challenge.user;
    if (!user?.totpSecretCipher || !user.totpSecretIv || !user.totpSecretTag) throw new Error("AUTH_TOTP_NOT_CONFIGURED");
    const secret = this.vault.decrypt({ ciphertext: Buffer.from(user.totpSecretCipher), iv: Buffer.from(user.totpSecretIv), tag: Buffer.from(user.totpSecretTag) });
    if (!verifyTotp(secret, code)) throw new Error("AUTH_TOTP_INVALID");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 12 * 60 * 60_000);
    const state: AuthSessionState = user.mustChangePassword ? "PASSWORD_CHANGE_REQUIRED" : "ACTIVE";
    await this.database.prisma.userSession.update({
      where: { id: challenge.id },
      data: { tokenHash: hashToken(token), state, attempts: 0, expiresAt, lastSeenAt: new Date() },
    });
    return { session: { token, expiresAt }, nextAction: nextAction(state), user: { id: user.id, email: user.email, displayName: user.displayName } };
  }

  async changePassword(userId: string | undefined, sessionId: string | undefined, currentPassword: string, newPassword: string) {
    if (!this.database.enabled) return { changed: true, nextAction: "NONE" as const, demo: true };
    if (!userId || !sessionId) throw new Error("AUTH_UNAUTHORIZED");
    const user = await this.database.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.active || !verifyPassword(currentPassword, user.passwordHash)) {
      await delay(250);
      throw new Error("AUTH_INVALID_CREDENTIALS");
    }
    if (verifyPassword(newPassword, user.passwordHash)) throw new Error("AUTH_PASSWORD_UNCHANGED");
    const state: AuthSessionState = user.totpEnabled ? "ACTIVE" : "TOTP_ENROLLMENT_REQUIRED";
    await this.database.prisma.$transaction(async (transaction) => {
      await transaction.user.update({ where: { id: userId }, data: { passwordHash: hashPassword(newPassword), mustChangePassword: false } });
      await transaction.userSession.updateMany({ where: { userId, id: { not: sessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
      await transaction.userSession.update({ where: { id: sessionId }, data: { state, attempts: 0 } });
      await transaction.auditLog.create({ data: { userId, channel: "WEB", action: "修改登录密码", resource: user.email, result: "SUCCEEDED", traceId: randomUUID() } });
    });
    return { changed: true, nextAction: nextAction(state), otherSessionsRevoked: true };
  }

  async logout(token?: string) {
    if (this.database.enabled && token) {
      await this.database.prisma.userSession.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return { loggedOut: true };
  }

  async securityStatus(userId?: string) {
    if (!this.database.enabled) return { totpEnabled: this.demoTotpEnabled, activeSessions: 1, demo: true };
    if (!userId) throw new Error("AUTH_UNAUTHORIZED");
    const user = await this.database.prisma.user.findUnique({ where: { id: userId }, select: { totpEnabled: true } });
    if (!user) throw new Error("AUTH_USER_NOT_FOUND");
    const activeSessions = await this.database.prisma.userSession.count({ where: { userId, state: { not: "TOTP_REQUIRED" }, revokedAt: null, expiresAt: { gt: new Date() } } });
    return { totpEnabled: user.totpEnabled, activeSessions, demo: false };
  }

  async beginTotpEnrollment(userId: string | undefined, currentPassword: string, currentCode?: string) {
    if (!this.database.enabled) return this.beginDemoEnrollment();
    if (!userId) throw new Error("AUTH_UNAUTHORIZED");
    const user = await this.database.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.active || !verifyPassword(currentPassword, user.passwordHash)) {
      await delay(250);
      throw new Error("AUTH_INVALID_CREDENTIALS");
    }
    if (user.totpEnabled) {
      if (!currentCode) throw new Error("AUTH_TOTP_REQUIRED");
      if (!user.totpSecretCipher || !user.totpSecretIv || !user.totpSecretTag) throw new Error("AUTH_TOTP_NOT_CONFIGURED");
      const currentSecret = this.vault.decrypt({ ciphertext: Buffer.from(user.totpSecretCipher), iv: Buffer.from(user.totpSecretIv), tag: Buffer.from(user.totpSecretTag) });
      if (!verifyTotp(currentSecret, currentCode)) throw new Error("AUTH_TOTP_INVALID");
    }
    const secret = encodeBase32(randomBytes(20));
    const encrypted = this.vault.encrypt(secret);
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const enrollment = await this.database.prisma.totpEnrollment.upsert({
      where: { userId },
      create: { userId, secretCipher: bytes(encrypted.ciphertext), secretIv: bytes(encrypted.iv), secretTag: bytes(encrypted.tag), expiresAt },
      update: { secretCipher: bytes(encrypted.ciphertext), secretIv: bytes(encrypted.iv), secretTag: bytes(encrypted.tag), attempts: 0, expiresAt, createdAt: new Date() },
    });
    return enrollmentResponse(enrollment.id, user.email, secret, expiresAt);
  }

  async confirmTotpEnrollment(userId: string | undefined, sessionId: string | undefined, enrollmentId: string, code: string) {
    if (!this.database.enabled) return this.confirmDemoEnrollment(enrollmentId, code);
    if (!userId || !sessionId) throw new Error("AUTH_UNAUTHORIZED");
    const enrollment = await this.database.prisma.totpEnrollment.findFirst({ where: { id: enrollmentId, userId }, include: { user: true } });
    if (!enrollment || enrollment.expiresAt.getTime() <= Date.now() || enrollment.attempts >= 5) {
      if (enrollment) await this.database.prisma.totpEnrollment.delete({ where: { id: enrollment.id } }).catch(() => undefined);
      throw new Error("AUTH_TOTP_ENROLLMENT_EXPIRED");
    }
    await this.database.prisma.totpEnrollment.update({ where: { id: enrollment.id }, data: { attempts: { increment: 1 } } });
    const secret = this.vault.decrypt({ ciphertext: Buffer.from(enrollment.secretCipher), iv: Buffer.from(enrollment.secretIv), tag: Buffer.from(enrollment.secretTag) });
    if (!verifyTotp(secret, code)) throw new Error("AUTH_TOTP_INVALID");
    const encrypted = { ciphertext: enrollment.secretCipher, iv: enrollment.secretIv, tag: enrollment.secretTag };
    await this.database.prisma.$transaction(async (transaction) => {
      await transaction.user.update({
        where: { id: userId },
        data: { totpEnabled: true, totpSecretCipher: encrypted.ciphertext, totpSecretIv: encrypted.iv, totpSecretTag: encrypted.tag },
      });
      await transaction.totpEnrollment.delete({ where: { id: enrollment.id } });
      await transaction.userSession.updateMany({ where: { userId, id: { not: sessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
      await transaction.userSession.update({ where: { id: sessionId }, data: { state: "ACTIVE", attempts: 0 } });
      await transaction.auditLog.create({ data: { userId, channel: "WEB", action: enrollment.user.totpEnabled ? "轮换 TOTP" : "启用 TOTP", resource: enrollment.user.email, result: "SUCCEEDED", traceId: randomUUID() } });
    });
    return { totpEnabled: true, otherSessionsRevoked: true };
  }

  async cancelTotpEnrollment(userId: string | undefined, enrollmentId: string) {
    if (!this.database.enabled) {
      const cancelled = this.demoEnrollment?.id === enrollmentId;
      if (cancelled) this.demoEnrollment = null;
      return { cancelled };
    }
    if (!userId) throw new Error("AUTH_UNAUTHORIZED");
    const result = await this.database.prisma.totpEnrollment.deleteMany({ where: { id: enrollmentId, userId } });
    return { cancelled: result.count > 0 };
  }

  private async createSession(userId: string, state: AuthSessionState = "ACTIVE", ttlMs = 12 * 60 * 60_000) {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlMs);
    await this.database.prisma.userSession.create({ data: { userId, tokenHash: hashToken(token), state, expiresAt } });
    return { token, expiresAt };
  }

  private beginDemoEnrollment() {
    const secret = encodeBase32(randomBytes(20));
    const enrollment = { id: randomUUID(), secret, expiresAt: Date.now() + 10 * 60_000, attempts: 0 };
    this.demoEnrollment = enrollment;
    return enrollmentResponse(enrollment.id, "admin@example.com", secret, new Date(enrollment.expiresAt), true);
  }

  private confirmDemoEnrollment(enrollmentId: string, code: string) {
    const enrollment = this.demoEnrollment;
    if (!enrollment || enrollment.id !== enrollmentId || enrollment.expiresAt <= Date.now() || enrollment.attempts >= 5) {
      this.demoEnrollment = null;
      throw new Error("AUTH_TOTP_ENROLLMENT_EXPIRED");
    }
    enrollment.attempts += 1;
    if (!verifyTotp(enrollment.secret, code)) throw new Error("AUTH_TOTP_INVALID");
    this.demoEnrollment = null;
    this.demoTotpEnabled = true;
    return { totpEnabled: true, otherSessionsRevoked: false, demo: true };
  }
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, n, r, p, saltValue, hashValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !saltValue || !hashValue) return false;
  const expected = Buffer.from(hashValue, "base64");
  const actual = scryptSync(password, Buffer.from(saltValue, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function verifyTotp(secretBase32: string, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = decodeBase32(secretBase32);
  const counter = Math.floor(now / 30_000);
  return [-1, 0, 1].some((offset) => timingSafeEqual(Buffer.from(totp(secret, counter + offset)), Buffer.from(code)));
}

export function generateTotpCode(secretBase32: string, now = Date.now()) {
  return totp(decodeBase32(secretBase32), Math.floor(now / 30_000));
}

function totp(secret: Buffer, counter: number) {
  const value = Buffer.alloc(8);
  value.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(value).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const number = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(number % 1_000_000).padStart(6, "0");
}

function decodeBase32(value: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("AUTH_TOTP_SECRET_INVALID");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function encodeBase32(value: Buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of value) bits += byte.toString(2).padStart(8, "0");
  let encoded = "";
  for (let index = 0; index < bits.length; index += 5) encoded += alphabet[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  return encoded;
}

function enrollmentResponse(id: string, email: string, secret: string, expiresAt: Date, demo = false) {
  const issuer = "富多店铺智能助手";
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`;
  const otpauthUri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  return { enrollmentId: id, secret, otpauthUri, expiresAt: expiresAt.toISOString(), ...(demo ? { demo: true } : {}) };
}

function bytes(value: Buffer): Uint8Array<ArrayBuffer> { const result = new Uint8Array(value.length); result.set(value); return result; }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function nextAction(state: AuthSessionState) {
  if (state === "PASSWORD_CHANGE_REQUIRED") return "CHANGE_PASSWORD" as const;
  if (state === "TOTP_ENROLLMENT_REQUIRED") return "TOTP_ENROLL" as const;
  if (state === "TOTP_REQUIRED") return "TOTP_VERIFY" as const;
  return "NONE" as const;
}
