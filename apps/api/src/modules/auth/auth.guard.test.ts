import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGuard } from "./auth.guard.js";
import { ALLOWED_SESSION_STATES } from "./session-state.decorator.js";

const originalDemoMode = process.env.DEMO_MODE;

beforeEach(() => { process.env.DEMO_MODE = "false"; });
afterEach(() => {
  if (originalDemoMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = originalDemoMode;
});

describe("AuthGuard session states", () => {
  it("allows only ACTIVE sessions on business endpoints", async () => {
    const active = guardFor("ACTIVE");
    await expect(active.guard.canActivate(active.context as never)).resolves.toBe(true);
    expect(active.request.user).toMatchObject({ id: "user-1", sessionState: "ACTIVE" });

    const restricted = guardFor("PASSWORD_CHANGE_REQUIRED");
    await expect(restricted.guard.canActivate(restricted.context as never)).rejects.toThrow("请先完成账号安全设置");
  });

  it("allows an explicitly listed restricted state only on setup endpoints", async () => {
    const setup = guardFor("TOTP_ENROLLMENT_REQUIRED", ["ACTIVE", "TOTP_ENROLLMENT_REQUIRED"]);
    await expect(setup.guard.canActivate(setup.context as never)).resolves.toBe(true);
    expect(setup.request.user).toMatchObject({ sessionState: "TOTP_ENROLLMENT_REQUIRED" });
  });
});

function guardFor(state: "ACTIVE" | "PASSWORD_CHANGE_REQUIRED" | "TOTP_ENROLLMENT_REQUIRED", allowed?: string[]) {
  const request: Record<string, unknown> = { cookies: { fuduo_session: "session-token" }, headers: {} };
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => key === ALLOWED_SESSION_STATES ? allowed : false),
  };
  const session = {
    id: "session-1",
    state,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    lastSeenAt: new Date(),
    user: { id: "user-1", email: "user@example.com", displayName: "User", active: true },
  };
  const database = { prisma: { userSession: { findUnique: vi.fn(async () => session), update: vi.fn() } } };
  const guard = new AuthGuard(reflector as never, database as never);
  const context = {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  };
  return { guard, context, request };
}
