import { describe, expect, it } from "vitest";
import { transitionQrSession, type QrSession } from "./erp-auth-state";

describe("ERP QR session state", () => {
  it("advances through scan and verification without accepting stale poll responses", () => {
    const waiting = session({ status: "WAITING_SCAN" });
    const scanned = session({ status: "SCANNED", qrImage: "data:image/png;base64,scan" });
    const verifying = session({ status: "VERIFYING", qrImage: null });

    expect(transitionQrSession(waiting, scanned)).toMatchObject({
      accepted: true,
      session: { status: "SCANNED" },
    });
    expect(transitionQrSession(scanned, waiting)).toEqual({
      accepted: false,
      session: scanned,
      terminalStatus: null,
    });
    expect(transitionQrSession(verifying, scanned)).toEqual({
      accepted: false,
      session: verifying,
      terminalStatus: null,
    });
  });

  it.each(["SUCCESS", "FAILED", "EXPIRED", "CANCELLED"] as const)(
    "closes the active QR view when the backend reports %s",
    (status) => {
      expect(transitionQrSession(session({ status: "VERIFYING" }), session({ status }))).toEqual({
        accepted: true,
        session: null,
        terminalStatus: status,
      });
    },
  );

  it("ignores delayed events from a replaced QR session", () => {
    const current = session({ id: "qr-new", status: "WAITING_SCAN" });
    const stale = session({ id: "qr-old", status: "SUCCESS" });

    expect(transitionQrSession(current, stale)).toEqual({
      accepted: false,
      session: current,
      terminalStatus: null,
    });
  });
});

function session(overrides: Partial<QrSession>): QrSession {
  return {
    id: "qr-1",
    status: "CREATED",
    qrImage: "data:image/png;base64,fixture",
    expiresAt: "2026-07-23T10:00:00.000Z",
    accountName: null,
    shopCount: null,
    error: null,
    ...overrides,
  };
}
