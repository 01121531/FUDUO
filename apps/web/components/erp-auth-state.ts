export interface QrSession {
  id: string;
  status: string;
  qrImage: string | null;
  expiresAt: string;
  accountName: string | null;
  shopCount: number | null;
  error: { message: string; recovery: string } | null;
}

export type TerminalQrStatus = "SUCCESS" | "FAILED" | "EXPIRED" | "CANCELLED";

export interface QrSessionTransition {
  accepted: boolean;
  session: QrSession | null;
  terminalStatus: TerminalQrStatus | null;
}

const QR_STATUS_ORDER: Record<string, number> = {
  CREATED: 0,
  WAITING_SCAN: 1,
  SCANNED: 2,
  VERIFYING: 3,
  SUCCESS: 4,
  FAILED: 4,
  EXPIRED: 4,
  CANCELLED: 4,
};

const TERMINAL_QR_STATES = new Set<TerminalQrStatus>([
  "SUCCESS",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
]);

export function isTerminalQrStatus(status: string): status is TerminalQrStatus {
  return TERMINAL_QR_STATES.has(status as TerminalQrStatus);
}

export function transitionQrSession(
  current: QrSession | null,
  incoming: QrSession,
): QrSessionTransition {
  if (!current || current.id !== incoming.id) {
    return { accepted: false, session: current, terminalStatus: null };
  }

  const currentOrder = QR_STATUS_ORDER[current.status] ?? -1;
  const incomingOrder = QR_STATUS_ORDER[incoming.status] ?? -1;
  if (incomingOrder < currentOrder) {
    return { accepted: false, session: current, terminalStatus: null };
  }

  if (isTerminalQrStatus(incoming.status)) {
    return { accepted: true, session: null, terminalStatus: incoming.status };
  }

  return { accepted: true, session: incoming, terminalStatus: null };
}
