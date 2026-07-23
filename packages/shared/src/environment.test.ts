import { describe, expect, it } from "vitest";
import {
  EnvironmentValidationError,
  validateApiEnvironment,
  validateOpenClawAdminEnvironment,
  validateWorkerEnvironment,
} from "./environment.js";

const masterKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64");
const internalToken = "0123456789abcdef".repeat(4);
const captureSecret = "fedcba9876543210".repeat(4);

describe("production environment validation", () => {
  it("allows an unconnected development demo without production secrets", () => {
    expect(() => validateApiEnvironment({ NODE_ENV: "development", DEMO_MODE: "true" })).not.toThrow();
  });

  it("treats an omitted demo flag as a live environment", () => {
    expect(() => validateApiEnvironment({ NODE_ENV: "development" })).toThrowError(/DATABASE_URL.*REDIS_URL.*CREDENTIAL_MASTER_KEY_BASE64/);
  });

  it("accepts a complete production API environment", () => {
    expect(() => validateApiEnvironment(validApiEnvironment())).not.toThrow();
  });

  it("rejects production demo mode and placeholder credentials without exposing their values", () => {
    const placeholder = "replace-with-openssl-rand-hex-32";
    let caught: unknown;
    try {
      validateApiEnvironment({
        ...validApiEnvironment(),
        DEMO_MODE: "true",
        INTERNAL_SERVICE_TOKEN: placeholder,
        CAPTURE_UPLOAD_SECRET: placeholder,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvironmentValidationError);
    const message = (caught as Error).message;
    expect(message).toContain("DEMO_MODE");
    expect(message).not.toContain(placeholder);
  });

  it("rejects malformed keys, non-HTTPS browser origins, and partial bootstrap accounts", () => {
    expect(() => validateApiEnvironment({
      ...validApiEnvironment(),
      CREDENTIAL_MASTER_KEY_BASE64: Buffer.from("too short").toString("base64"),
      WEB_ORIGIN: "http://localhost:3000",
      BOOTSTRAP_ADMIN_EMAIL: "admin@company.test",
    })).toThrowError(/CREDENTIAL_MASTER_KEY_BASE64.*WEB_ORIGIN.*BOOTSTRAP_ADMIN_/);
  });

  it("validates all bootstrap account fields when initialization is requested", () => {
    expect(() => validateApiEnvironment({
      ...validApiEnvironment(),
      BOOTSTRAP_ADMIN_EMAIL: "admin@company.test",
      BOOTSTRAP_ADMIN_PASSWORD: "A-strong-bootstrap-password-2026",
      BOOTSTRAP_ADMIN_TOTP_SECRET_BASE32: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    })).not.toThrow();
    expect(() => validateApiEnvironment({
      ...validApiEnvironment(),
      BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
      BOOTSTRAP_ADMIN_PASSWORD: "replace-with-a-long-random-password",
      BOOTSTRAP_ADMIN_TOTP_SECRET_BASE32: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    })).toThrowError(/BOOTSTRAP_ADMIN_EMAIL.*BOOTSTRAP_ADMIN_PASSWORD.*BOOTSTRAP_ADMIN_TOTP/);
  });

  it("validates worker database, Redis, vault, internal API, and service credentials", () => {
    const valid = {
      DATABASE_URL: "postgresql://fuduo:password@postgres:5432/fuduo_assistant",
      REDIS_URL: "redis://:password@redis:6379",
      CREDENTIAL_MASTER_KEY_BASE64: masterKey,
      INTERNAL_SERVICE_TOKEN: internalToken,
      API_INTERNAL_URL: "http://api:3001/api",
    };
    expect(() => validateWorkerEnvironment(valid)).not.toThrow();
    expect(() => validateWorkerEnvironment({ ...valid, REDIS_URL: "https://redis.invalid", API_INTERNAL_URL: "file:///tmp/api" })).toThrowError(/REDIS_URL.*API_INTERNAL_URL/);
    expect(() => validateWorkerEnvironment({ ...valid, API_INTERNAL_URL: "https://attacker.example/api" })).toThrowError(/API_INTERNAL_URL must target the internal API service/);
    expect(() => validateWorkerEnvironment({ ...valid, WORKER_HEALTH_PORT: "70000" })).toThrowError(/WORKER_HEALTH_PORT/);
  });

  it("validates the OpenClaw Admin token, state directory, and port", () => {
    expect(() => validateOpenClawAdminEnvironment({
      OPENCLAW_ADMIN_TOKEN: internalToken,
      OPENCLAW_STATE_DIR: "/root/.openclaw",
      OPENCLAW_ADMIN_PORT: "18790",
    })).not.toThrow();
    expect(() => validateOpenClawAdminEnvironment({
      OPENCLAW_ADMIN_TOKEN: "short",
      OPENCLAW_STATE_DIR: "",
      OPENCLAW_ADMIN_PORT: "70000",
    })).toThrowError(/OPENCLAW_ADMIN_TOKEN.*OPENCLAW_STATE_DIR.*OPENCLAW_ADMIN_PORT/);
  });
});

function validApiEnvironment() {
  return {
    NODE_ENV: "production",
    DEMO_MODE: "false",
    DATABASE_URL: "postgresql://fuduo:password@postgres:5432/fuduo_assistant",
    REDIS_URL: "redis://:password@redis:6379",
    CREDENTIAL_MASTER_KEY_BASE64: masterKey,
    INTERNAL_SERVICE_TOKEN: internalToken,
    CAPTURE_UPLOAD_SECRET: captureSecret,
    FUDUO_API_BASE_URL: "https://erp.fuduo8888.com",
    WEB_ORIGIN: "https://assistant.company.test",
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/usr/bin/chromium",
    OPENCLAW_ADMIN_URL: "http://openclaw-admin:18790",
    OPENCLAW_ADMIN_TOKEN: internalToken,
    OPENCLAW_GATEWAY_URL: "http://openclaw:18789",
  };
}
