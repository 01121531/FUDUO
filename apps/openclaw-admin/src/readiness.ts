import { constants } from "node:fs";
import { access } from "node:fs/promises";

export interface ReadinessOptions {
  stateDir: string;
  gatewayHealthUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  accessImpl?: typeof access;
}

export function createReadinessCheck(options: ReadinessOptions) {
  const gatewayHealthUrl = validateGatewayHealthUrl(options.gatewayHealthUrl);
  const timeoutMs = options.timeoutMs ?? 3_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const accessImpl = options.accessImpl ?? access;

  if (!options.stateDir.trim()) throw new Error("OPENCLAW_STATE_DIR_REQUIRED");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    throw new Error("OPENCLAW_READINESS_TIMEOUT_INVALID");
  }

  return async () => {
    try {
      await accessImpl(options.stateDir, constants.R_OK | constants.W_OK);
      const response = await fetchImpl(gatewayHealthUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}

function validateGatewayHealthUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("OPENCLAW_GATEWAY_HEALTH_URL_INVALID");
  }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/readyz") {
    throw new Error("OPENCLAW_GATEWAY_HEALTH_URL_INVALID");
  }
  return parsed.toString();
}
