import type { OpenClawPairingState } from "./openclaw-admin.service.js";

export type WechatPairingStatus =
  "PENDING" | "PAIRED" | "UNBOUND" | "NEEDS_REVIEW" | "UNKNOWN";

const NICKNAME_KEYS = [
  "displayName",
  "nickname",
  "nickName",
  "name",
  "senderName",
  "userName",
] as const;

export function normalizeWechatNickname(meta?: Record<string, unknown> | null) {
  if (!meta) return null;
  for (const key of NICKNAME_KEYS) {
    const value = meta[key];
    if (typeof value !== "string") continue;
    const normalized = value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (normalized) return Array.from(normalized).slice(0, 120).join("");
  }
  return null;
}

export function resolveWechatPairingStatus(
  runtime: OpenClawPairingState | null,
  externalUserId: string,
): WechatPairingStatus {
  if (!runtime) return "UNKNOWN";
  return runtime.approved.includes(externalUserId) ? "PAIRED" : "NEEDS_REVIEW";
}
