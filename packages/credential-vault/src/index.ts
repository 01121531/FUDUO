import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export interface JwtClaims {
  exp: number;
  iss: string | null;
  subject: string | null;
  raw: Record<string, unknown>;
}

export class VaultCipher {
  private readonly key: Buffer;

  constructor(masterKeyBase64?: string, allowDevelopmentKey = false) {
    if (!masterKeyBase64 && !allowDevelopmentKey) {
      throw new Error("CREDENTIAL_MASTER_KEY_BASE64 is required");
    }
    this.key = masterKeyBase64
      ? Buffer.from(masterKeyBase64, "base64")
      : createHash("sha256").update("development-only-fuduo-key").digest();
    if (this.key.length !== 32) {
      throw new Error("CREDENTIAL_MASTER_KEY_BASE64 must decode to exactly 32 bytes");
    }
  }

  encrypt(value: string): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  decrypt(value: EncryptedPayload): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, value.iv);
    decipher.setAuthTag(value.tag);
    return Buffer.concat([decipher.update(value.ciphertext), decipher.final()]).toString("utf8");
  }
}

export function normalizeAuthorization(value: string): string {
  return value.replace(/^Bearer\s+/i, "").trim();
}

export function parseJwtClaims(value: string): JwtClaims | null {
  try {
    const payloadPart = normalizeAuthorization(value).split(".")[1];
    if (!payloadPart) return null;
    const raw = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof raw.exp !== "number") return null;
    const subject = typeof raw.sub === "string" ? raw.sub : typeof raw.uid === "number" ? String(raw.uid) : null;
    return {
      exp: raw.exp,
      iss: typeof raw.iss === "string" ? raw.iss : null,
      subject,
      raw,
    };
  } catch {
    return null;
  }
}

export function shouldRefreshJwt(value: string, now = Date.now(), leadMs = 30 * 60_000): boolean {
  const claims = parseJwtClaims(value);
  return claims !== null && claims.exp * 1000 - now <= leadMs;
}
