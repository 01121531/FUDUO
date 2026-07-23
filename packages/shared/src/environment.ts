type Environment = Record<string, string | undefined>;

export class EnvironmentValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`CONFIG_INVALID: ${issues.join("; ")}`);
    this.name = "EnvironmentValidationError";
  }
}

export function validateApiEnvironment(env: Environment = process.env) {
  const issues: string[] = [];
  const production = env.NODE_ENV === "production";
  const live = env.DEMO_MODE !== "true";
  if (production && !live) issues.push("DEMO_MODE must be false in production");
  if (!live) return finish(issues);

  databaseUrl(env.DATABASE_URL, issues);
  redisUrl(env.REDIS_URL, issues);
  masterKey(env.CREDENTIAL_MASTER_KEY_BASE64, issues);
  secret("INTERNAL_SERVICE_TOKEN", env.INTERNAL_SERVICE_TOKEN, issues);
  secret("CAPTURE_UPLOAD_SECRET", env.CAPTURE_UPLOAD_SECRET, issues);
  httpsUrl("FUDUO_API_BASE_URL", env.FUDUO_API_BASE_URL ?? "https://erp.fuduo8888.com", issues);

  const openclawAdminUrl = required("OPENCLAW_ADMIN_URL", env.OPENCLAW_ADMIN_URL, issues);
  if (openclawAdminUrl) serviceUrl("OPENCLAW_ADMIN_URL", openclawAdminUrl, issues);
  secret("OPENCLAW_ADMIN_TOKEN", env.OPENCLAW_ADMIN_TOKEN, issues);
  const gatewayUrl = required("OPENCLAW_GATEWAY_URL", env.OPENCLAW_GATEWAY_URL, issues);
  if (gatewayUrl) serviceUrl("OPENCLAW_GATEWAY_URL", gatewayUrl, issues);

  if (production) {
    webOrigins(env.WEB_ORIGIN, issues);
    required("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, issues);
  }
  bootstrapAdmin(env, issues);
  return finish(issues);
}

export function validateWorkerEnvironment(env: Environment = process.env) {
  const issues: string[] = [];
  databaseUrl(env.DATABASE_URL, issues);
  redisUrl(env.REDIS_URL, issues);
  masterKey(env.CREDENTIAL_MASTER_KEY_BASE64, issues);
  secret("INTERNAL_SERVICE_TOKEN", env.INTERNAL_SERVICE_TOKEN, issues);
  const apiUrl = required("API_INTERNAL_URL", env.API_INTERNAL_URL, issues);
  if (apiUrl) internalApiUrl(apiUrl, issues);
  httpsUrl("FUDUO_API_BASE_URL", env.FUDUO_API_BASE_URL ?? "https://erp.fuduo8888.com", issues);
  integer("WORKER_HEALTH_PORT", env.WORKER_HEALTH_PORT ?? "3002", 1, 65_535, issues);
  required("WORKER_HEALTH_HOST", env.WORKER_HEALTH_HOST ?? "127.0.0.1", issues);
  return finish(issues);
}

export function validateOpenClawAdminEnvironment(env: Environment = process.env) {
  const issues: string[] = [];
  secret("OPENCLAW_ADMIN_TOKEN", env.OPENCLAW_ADMIN_TOKEN, issues);
  required("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR, issues);
  integer("OPENCLAW_ADMIN_PORT", env.OPENCLAW_ADMIN_PORT ?? "18790", 1, 65_535, issues);
  required("OPENCLAW_ADMIN_HOST", env.OPENCLAW_ADMIN_HOST ?? "0.0.0.0", issues);
  return finish(issues);
}

function databaseUrl(value: string | undefined, issues: string[]) {
  const requiredValue = required("DATABASE_URL", value, issues);
  if (requiredValue) url("DATABASE_URL", requiredValue, new Set(["postgres:", "postgresql:"]), issues, true);
}

function redisUrl(value: string | undefined, issues: string[]) {
  const requiredValue = required("REDIS_URL", value, issues);
  if (requiredValue) url("REDIS_URL", requiredValue, new Set(["redis:", "rediss:"]), issues, true);
}

function httpsUrl(name: string, value: string, issues: string[]) {
  url(name, value, new Set(["https:"]), issues, false);
}

function serviceUrl(name: string, value: string, issues: string[]) {
  url(name, value, new Set(["http:", "https:"]), issues, false);
}

function internalApiUrl(value: string, issues: string[]) {
  try {
    const parsed = new URL(value);
    const hosts = new Set(["api", "localhost", "127.0.0.1"]);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) issues.push("API_INTERNAL_URL uses an unsupported protocol");
    if (!hosts.has(parsed.hostname.toLowerCase())) issues.push("API_INTERNAL_URL must target the internal API service");
    if (parsed.username || parsed.password) issues.push("API_INTERNAL_URL must not include credentials");
    if (parsed.search || parsed.hash) issues.push("API_INTERNAL_URL must not include query parameters or fragments");
  } catch {
    issues.push("API_INTERNAL_URL must be a valid URL");
  }
}

function url(name: string, value: string, protocols: Set<string>, issues: string[], credentialsAllowed: boolean) {
  try {
    const parsed = new URL(value);
    if (!protocols.has(parsed.protocol)) issues.push(`${name} uses an unsupported protocol`);
    if (!parsed.hostname) issues.push(`${name} must include a host`);
    if (!credentialsAllowed && (parsed.username || parsed.password)) issues.push(`${name} must not include credentials`);
    if (parsed.hash) issues.push(`${name} must not include a fragment`);
  } catch {
    issues.push(`${name} must be a valid URL`);
  }
}

function webOrigins(value: string | undefined, issues: string[]) {
  const configured = required("WEB_ORIGIN", value, issues);
  if (!configured) return;
  const origins = configured.split(",").map((item) => item.trim()).filter(Boolean);
  if (!origins.length) {
    issues.push("WEB_ORIGIN must include at least one origin");
    return;
  }
  for (const origin of origins) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.hostname === "localhost" || parsed.hostname.endsWith(".example.com")) {
        issues.push("WEB_ORIGIN entries must be exact production HTTPS origins");
      }
    } catch {
      issues.push("WEB_ORIGIN entries must be valid URLs");
    }
  }
}

function masterKey(value: string | undefined, issues: string[]) {
  const configured = required("CREDENTIAL_MASTER_KEY_BASE64", value, issues);
  if (!configured) return;
  if (placeholder(configured) || !/^[A-Za-z0-9+/]{43}=$/.test(configured) || Buffer.from(configured, "base64").length !== 32) {
    issues.push("CREDENTIAL_MASTER_KEY_BASE64 must be a generated 32-byte Base64 value");
  }
}

function secret(name: string, value: string | undefined, issues: string[], minimum = 32) {
  const configured = required(name, value, issues);
  if (!configured) return;
  if (configured.length < minimum || placeholder(configured) || new Set(configured).size < 8) {
    issues.push(`${name} must be a generated secret with at least ${minimum} characters`);
  }
}

function bootstrapAdmin(env: Environment, issues: string[]) {
  const names = ["BOOTSTRAP_ADMIN_EMAIL", "BOOTSTRAP_ADMIN_PASSWORD", "BOOTSTRAP_ADMIN_TOTP_SECRET_BASE32"] as const;
  const configured = names.filter((name) => Boolean(env[name]?.trim()));
  if (configured.length === 0) return;
  if (configured.length !== names.length) {
    issues.push("BOOTSTRAP_ADMIN_* values must be configured together");
    return;
  }
  const email = env.BOOTSTRAP_ADMIN_EMAIL!.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.toLowerCase().endsWith("@example.com")) {
    issues.push("BOOTSTRAP_ADMIN_EMAIL must be a non-placeholder email address");
  }
  secret("BOOTSTRAP_ADMIN_PASSWORD", env.BOOTSTRAP_ADMIN_PASSWORD, issues, 16);
  const totp = env.BOOTSTRAP_ADMIN_TOTP_SECRET_BASE32!.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z2-7]{32,}$/.test(totp) || new Set(totp).size < 8) {
    issues.push("BOOTSTRAP_ADMIN_TOTP_SECRET_BASE32 must be a generated Base32 secret");
  }
}

function integer(name: string, value: string, minimum: number, maximum: number, issues: string[]) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) issues.push(`${name} must be an integer from ${minimum} to ${maximum}`);
}

function required(name: string, value: string | undefined, issues: string[]) {
  const normalized = value?.trim();
  if (!normalized) {
    issues.push(`${name} is required`);
    return null;
  }
  return normalized;
}

function placeholder(value: string) {
  return /replace[-_ ]?with|change[-_ ]?me|changeme|placeholder|your[-_ ]|example[-_ ]?(?:key|secret|password)/i.test(value);
}

function finish(issues: string[]) {
  if (issues.length) throw new EnvironmentValidationError([...new Set(issues)]);
}
