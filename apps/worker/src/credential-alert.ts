import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { internalApiOptions, requestInternalApi, type InternalApiOptions } from "./report-api.js";

const SUCCESS_TTL_MS = 7 * 24 * 60 * 60_000;
const RETRY_TTL_MS = 10 * 60_000;
const EXTEND_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

export async function notifyErpReauthRequired(
  redis: Redis,
  credentialVersion: number,
  options: InternalApiOptions = internalApiOptions(),
) {
  if (!Number.isInteger(credentialVersion) || credentialVersion < 0) throw new Error("ERP_CREDENTIAL_VERSION_INVALID");
  const key = `fuduo:alert:erp-reauth:${credentialVersion}`;
  const owner = randomUUID();
  const acquired = await redis.set(key, owner, "PX", RETRY_TTL_MS, "NX");
  if (acquired !== "OK") return { notified: false, deduplicated: true };

  const result = await requestInternalApi(options, "/internal/alerts/erp-reauth", undefined, "ERP_REAUTH_ALERT_FAILED");
  const record = isRecord(result) ? result : {};
  const sent = integer(record.sent);
  const failed = integer(record.failed);
  const total = integer(record.total);
  if (sent > 0 && failed === 0) {
    await redis.eval(EXTEND_SCRIPT, 1, key, owner, String(SUCCESS_TTL_MS)).catch(() => undefined);
  }
  return { notified: sent > 0, deduplicated: false, total, sent, failed };
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
