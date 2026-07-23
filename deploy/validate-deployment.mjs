import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";

const deployDir = path.dirname(fileURLToPath(import.meta.url));
const compose = parse(
  readFileSync(path.join(deployDir, "docker-compose.yml"), "utf8"),
);
const dockerfile = readFileSync(path.join(deployDir, "Dockerfile"), "utf8");
const envExample = readFileSync(path.join(deployDir, ".env.example"), "utf8");
const openclawEntrypoint = readFileSync(
  path.join(deployDir, "openclaw-entrypoint.sh"),
  "utf8",
);
const openclawBackup = readFileSync(
  path.join(deployDir, "openclaw-state-backup.sh"),
  "utf8",
);
const postgresBackup = readFileSync(
  path.join(deployDir, "postgres-backup.sh"),
  "utf8",
);
const postgresRestore = readFileSync(
  path.join(deployDir, "postgres-restore.sh"),
  "utf8",
);
const openclawRestore = readFileSync(
  path.join(deployDir, "openclaw-state-restore.sh"),
  "utf8",
);
const recoveryGuide = readFileSync(path.join(deployDir, "RECOVERY.md"), "utf8");
const caddyfile = readFileSync(path.join(deployDir, "Caddyfile"), "utf8");
const composeSource = readFileSync(
  path.join(deployDir, "docker-compose.yml"),
  "utf8",
);
const issues = [];

if (
  (composeSource.match(/\$\{POSTGRES_DATABASE:-fuduo_assistant\}/g) ?? [])
    .length < 5
) {
  issues.push(
    "all PostgreSQL clients must use the selectable POSTGRES_DATABASE",
  );
}
if (
  (composeSource.match(/\$\{OPENCLAW_STATE_VOLUME:-openclaw-data\}/g) ?? [])
    .length !== 3
) {
  issues.push(
    "OpenClaw, Admin and backup must use the same selectable state volume",
  );
}

const hardenedServices = [
  "migrate",
  "backup",
  "postgres-restore",
  "api",
  "worker",
  "web",
  "openclaw",
  "openclaw-admin",
  "openclaw-backup",
  "openclaw-state-restore",
];
for (const name of hardenedServices) {
  const service = compose?.services?.[name];
  if (!service) {
    issues.push(`service ${name} is missing`);
    continue;
  }
  if (service.read_only !== true)
    issues.push(`${name} must use a read-only root filesystem`);
  if (!Array.isArray(service.cap_drop) || !service.cap_drop.includes("ALL"))
    issues.push(`${name} must drop all Linux capabilities`);
  if (
    !Array.isArray(service.security_opt) ||
    !service.security_opt.includes("no-new-privileges:true")
  )
    issues.push(`${name} must enable no-new-privileges`);
  if (
    name !== "backup" &&
    (!Array.isArray(service.tmpfs) || service.tmpfs.length === 0)
  )
    issues.push(`${name} must declare bounded temporary storage`);
  if (service.ports) issues.push(`${name} must not publish a host port`);
}

for (const target of [
  "api",
  "worker",
  "web",
  "openclaw",
  "openclaw-admin",
  "openclaw-state-backup",
  "openclaw-state-restore",
]) {
  const section = dockerTarget(dockerfile, target);
  if (!section) issues.push(`Dockerfile target ${target} is missing`);
  else if (!/^USER node$/m.test(section))
    issues.push(`Dockerfile target ${target} must run as node`);
}

const postgresRestoreTarget = dockerTarget(dockerfile, "postgres-restore");
if (!postgresRestoreTarget)
  issues.push("Dockerfile target postgres-restore is missing");
else if (!/^USER postgres$/m.test(postgresRestoreTarget))
  issues.push("Dockerfile target postgres-restore must run as postgres");

for (const name of ["openclaw", "openclaw-admin"]) {
  const volumes = compose.services[name]?.volumes ?? [];
  if (
    !volumes.includes(
      "${OPENCLAW_STATE_VOLUME:-openclaw-data}:/home/node/.openclaw",
    )
  )
    issues.push(
      `${name} must share the selectable non-root OpenClaw state volume`,
    );
}

if (!compose.services.worker?.healthcheck?.test)
  issues.push("worker must declare a readiness healthcheck");
const migrateCommand = JSON.stringify(compose.services.migrate?.command ?? []);
if (
  !migrateCommand.includes("db:deploy") ||
  !migrateCommand.includes("db:status")
) {
  issues.push("migrate must deploy migrations and verify their final status");
}
assertDependency("api", "migrate", "service_completed_successfully");
assertDependency("worker", "migrate", "service_completed_successfully");
assertDependency("backup", "postgres", "service_healthy");
assertHealthcheck("web", "http://127.0.0.1:3000/");
assertHealthcheck("openclaw", "http://127.0.0.1:18789/readyz");
assertHealthcheck("openclaw-admin", "http://127.0.0.1:18790/health/ready");
assertDependency("openclaw-admin", "openclaw", "service_healthy");
assertDependency("openclaw-backup", "openclaw", "service_healthy");
assertDependency("caddy", "api", "service_healthy");
assertDependency("caddy", "web", "service_healthy");

const postgresBackupVolumes = compose.services.backup?.volumes ?? [];
if (!postgresBackupVolumes.includes("postgres-backups:/backups"))
  issues.push("backup must use the dedicated PostgreSQL backup volume");
if (!Object.hasOwn(compose.volumes ?? {}, "postgres-backups"))
  issues.push("postgres-backups volume is missing");
for (const marker of [
  "pg_dump",
  "--format custom",
  "aes-256-cbc",
  "-pbkdf2",
  "pg_restore --list",
  "sha256sum",
]) {
  if (!postgresBackup.includes(marker))
    issues.push(`PostgreSQL backup must include ${marker}`);
}

const openclawBackupVolumes =
  compose.services["openclaw-backup"]?.volumes ?? [];
if (
  !openclawBackupVolumes.includes(
    "${OPENCLAW_STATE_VOLUME:-openclaw-data}:/state:ro",
  )
)
  issues.push(
    "openclaw-backup must mount the selected OpenClaw state read-only",
  );
if (!openclawBackupVolumes.includes("openclaw-backups:/backups"))
  issues.push("openclaw-backup must use a dedicated backup volume");
if (!Object.hasOwn(compose.volumes ?? {}, "openclaw-backups"))
  issues.push("openclaw-backups volume is missing");
for (const marker of [
  "aes-256-cbc",
  "-pbkdf2",
  "BACKUP_ENCRYPTION_PASSWORD",
  "tar -tzf",
]) {
  if (!openclawBackup.includes(marker))
    issues.push(`OpenClaw backup must include ${marker}`);
}

assertRecoveryService("postgres-restore", "postgres-backups:/backups:ro");
assertRecoveryService("openclaw-state-restore", "openclaw-backups:/backups:ro");
const openclawRestoreVolumes =
  compose.services["openclaw-state-restore"]?.volumes ?? [];
if (!openclawRestoreVolumes.includes("openclaw-restore-data:/restore"))
  issues.push(
    "OpenClaw restore drills must use an isolated destination volume",
  );
if (!Object.hasOwn(compose.volumes ?? {}, "openclaw-restore-data"))
  issues.push("openclaw-restore-data volume is missing");
for (const marker of [
  "sha256sum",
  "pg_restore --list",
  "RESTORE_CONFIRM_DATABASE",
  "_prisma_migrations",
  "Refusing to restore over",
]) {
  if (!postgresRestore.includes(marker))
    issues.push(`PostgreSQL restore must include ${marker}`);
}
for (const marker of [
  "sha256sum",
  "tar -tzf",
  "RESTORE_CONFIRM_PATH",
  "OPENCLAW_RESTORE_TARGET",
  'RESTORE_TARGET" = "/restore',
]) {
  if (!openclawRestore.includes(marker))
    issues.push(`OpenClaw restore must include ${marker}`);
}
for (const marker of [
  "service_completed_successfully",
  "RESTORE_TARGET_DB",
  "RESTORE_CONFIRM_DATABASE",
  "RESTORE_CONFIRM_PATH",
  "异机",
]) {
  if (!recoveryGuide.includes(marker))
    issues.push(`Recovery guide must include ${marker}`);
}

if (/reverse_proxy\s+openclaw:18789/.test(caddyfile))
  issues.push(
    "OpenClaw Gateway must not be exposed by the public reverse proxy",
  );
const caddyNetworks = compose.services.caddy?.networks ?? [];
if (!Array.isArray(caddyNetworks) || caddyNetworks.includes("backend"))
  issues.push("caddy must be isolated from the backend network");
for (const serviceName of ["postgres", "redis", "openclaw", "openclaw-admin"]) {
  const networks = compose.services[serviceName]?.networks ?? [];
  if (
    !Array.isArray(networks) ||
    networks.includes("edge") ||
    !networks.includes("backend")
  ) {
    issues.push(`${serviceName} must be isolated on the backend network`);
  }
}

const redisCommand = JSON.stringify(compose.services.redis?.command ?? []);
if (redisCommand.includes("${REDIS_PASSWORD}"))
  issues.push(
    "Redis password must not be interpolated into its process arguments",
  );
if (/gateway run[\s\S]*--token\b/.test(openclawEntrypoint))
  issues.push("Gateway token must not be passed on the command line");
if (!/config set logging\.redactSensitive tools/.test(openclawEntrypoint))
  issues.push("OpenClaw sensitive log redaction must be explicitly enabled");

const requiredFuduoTools = [
  "list_shops",
  "get_shop_sales",
  "compare_shop_sales",
  "rank_shops_by_sales",
  "get_sales_summary",
  "get_shop_orders",
  "get_shop_refunds",
  "generate_daily_report",
  "generate_weekly_report",
  "get_data_freshness",
  "get_sync_status",
];
const toolAllow = parseShellJsonSetting(openclawEntrypoint, "tools.allow");
const toolDeny = parseShellJsonSetting(openclawEntrypoint, "tools.deny");
if (JSON.stringify(toolAllow) !== JSON.stringify(requiredFuduoTools))
  issues.push(
    "OpenClaw tools.allow must contain only the fixed Fuduo tool contract",
  );
for (const denied of [
  "group:openclaw",
  "group:fs",
  "group:runtime",
  "canvas",
]) {
  if (!toolDeny.includes(denied))
    issues.push(`OpenClaw tools.deny must include ${denied}`);
}

const referencedVariables = new Set(
  [...composeSource.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map(
    (match) => match[1],
  ),
);
const documentedVariables = new Set(
  [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]),
);
for (const variable of referencedVariables) {
  if (!documentedVariables.has(variable))
    issues.push(`${variable} is missing from deploy/.env.example`);
}

const envFileArg = process.argv.find((argument) =>
  argument.startsWith("--env-file="),
);
if (envFileArg)
  validateRuntimeEnvironment(
    path.resolve(process.cwd(), envFileArg.slice("--env-file=".length)),
  );

if (issues.length) {
  process.stderr.write(
    `${JSON.stringify({ status: "invalid", issues }, null, 2)}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `${JSON.stringify({ status: "ok", hardenedServices: hardenedServices.length, documentedVariables: referencedVariables.size })}\n`,
);

function dockerTarget(source, name) {
  const match = source.match(
    new RegExp(`FROM [^\\n]+ AS ${name}\\n([\\s\\S]*?)(?=\\nFROM |$)`, "i"),
  );
  return match?.[1] ?? null;
}

function parseShellJsonSetting(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`config set ${escaped} \\\\?\\s*\\n?\\s*'([^']+)'`),
  );
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function assertHealthcheck(serviceName, expectedUrl) {
  const test = JSON.stringify(
    compose.services[serviceName]?.healthcheck?.test ?? [],
  );
  if (!test.includes(expectedUrl))
    issues.push(`${serviceName} must probe ${expectedUrl}`);
}

function assertDependency(serviceName, dependencyName, condition) {
  const configured =
    compose.services[serviceName]?.depends_on?.[dependencyName]?.condition;
  if (configured !== condition)
    issues.push(
      `${serviceName} must wait for ${dependencyName} with ${condition}`,
    );
}

function assertRecoveryService(serviceName, readOnlyBackupMount) {
  const service = compose.services[serviceName];
  if (
    !Array.isArray(service?.profiles) ||
    !service.profiles.includes("recovery")
  ) {
    issues.push(`${serviceName} must be opt-in through the recovery profile`);
  }
  if (!(service?.volumes ?? []).includes(readOnlyBackupMount)) {
    issues.push(`${serviceName} must mount its backup volume read-only`);
  }
  if (service?.restart !== "no")
    issues.push(`${serviceName} must be a one-shot service`);
}

function validateRuntimeEnvironment(file) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    issues.push("runtime env file cannot be read");
    return;
  }
  const values = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)\s*$/);
    if (!match) continue;
    values.set(match[1], unquote(match[2].trim()));
  }
  for (const name of referencedVariables) {
    if (!values.get(name)?.trim() && !hasComposeDefault(name))
      issues.push(`${name} is missing from the runtime env file`);
  }
  for (const name of [
    "POSTGRES_PASSWORD",
    "BACKUP_ENCRYPTION_PASSWORD",
    "REDIS_PASSWORD",
    "INTERNAL_SERVICE_TOKEN",
    "CAPTURE_UPLOAD_SECRET",
    "OPENCLAW_GATEWAY_TOKEN",
    "BOOTSTRAP_ADMIN_PASSWORD",
  ]) {
    const value = values.get(name) ?? "";
    if (value.length < 32 || placeholder(value) || new Set(value).size < 8)
      issues.push(
        `${name} must be a generated secret with at least 32 characters`,
      );
  }
  const masterKey = values.get("CREDENTIAL_MASTER_KEY_BASE64") ?? "";
  if (
    !/^[A-Za-z0-9+/]{43}=$/.test(masterKey) ||
    Buffer.from(masterKey, "base64").length !== 32 ||
    placeholder(masterKey)
  ) {
    issues.push(
      "CREDENTIAL_MASTER_KEY_BASE64 must be a generated 32-byte Base64 value",
    );
  }
  const siteAddress = values.get("SITE_ADDRESS") ?? "";
  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
      siteAddress,
    ) ||
    siteAddress.endsWith(".example.com")
  ) {
    issues.push("SITE_ADDRESS must be a production hostname");
  }
  const postgresDatabase = values.get("POSTGRES_DATABASE") || "fuduo_assistant";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(postgresDatabase)) {
    issues.push("POSTGRES_DATABASE must be a valid PostgreSQL identifier");
  }
  const openclawStateVolume =
    values.get("OPENCLAW_STATE_VOLUME") || "openclaw-data";
  if (
    !["openclaw-data", "openclaw-restore-data"].includes(openclawStateVolume)
  ) {
    issues.push(
      "OPENCLAW_STATE_VOLUME must select a declared OpenClaw state volume",
    );
  }
}

function hasComposeDefault(name) {
  return new RegExp(`\\$\\{${name}:-[^}]*}`).test(composeSource);
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  )
    return value.slice(1, -1);
  return value;
}

function placeholder(value) {
  return /replace[-_ ]?with|change[-_ ]?me|changeme|placeholder|your[-_ ]|example[-_ ]?(?:key|secret|password)/i.test(
    value,
  );
}
