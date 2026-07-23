import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface ExtensionInstallBundle {
  kind: "SKILL" | "MCP";
  slug: string;
  version: number;
  manifest: Record<string, unknown>;
  files: Array<{ path: string; content: string }>;
}

export class ExtensionInstaller {
  constructor(
    private readonly stateDir: string,
    private readonly runOpenClaw: (args: string[], timeoutMs?: number) => Promise<void> = defaultOpenClawRunner,
  ) {}

  async install(bundle: ExtensionInstallBundle) {
    validateBundle(bundle);
    const archiveRoot = path.join(this.stateDir, "fuduo-extension-versions", bundle.slug, `v${bundle.version}`);
    const activeRoot = bundle.kind === "SKILL"
      ? path.join(this.stateDir, "workspace", "skills", bundle.slug)
      : path.join(this.stateDir, "workspace", "mcp", bundle.slug);
    const temporaryRoot = `${activeRoot}.installing`;
    const rollbackRoot = `${activeRoot}.rollback`;
    const hadActiveVersion = await exists(activeRoot);
    const previousMcp = bundle.kind === "MCP" && hadActiveVersion
      ? await readInstalledMcp(activeRoot)
      : null;

    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(rollbackRoot, { recursive: true, force: true });
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    await writeBundle(temporaryRoot, bundle);

    await rm(archiveRoot, { recursive: true, force: true });
    await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
    await writeBundle(archiveRoot, bundle);

    await mkdir(path.dirname(activeRoot), { recursive: true, mode: 0o700 });
    let registered = false;
    try {
      if (hadActiveVersion) await rename(activeRoot, rollbackRoot);
      await rename(temporaryRoot, activeRoot);
      if (bundle.kind === "MCP") {
        await this.registerMcp(bundle, activeRoot);
        registered = true;
      }
      await this.updateRegistry(bundle, activeRoot, archiveRoot);
    } catch (error) {
      if (registered) await this.unregisterMcp(bundle.slug);
      await rm(activeRoot, { recursive: true, force: true });
      if (hadActiveVersion) await rename(rollbackRoot, activeRoot);
      if (previousMcp) await this.registerMcp(previousMcp, activeRoot).catch(() => undefined);
      throw error;
    }
    await rm(rollbackRoot, { recursive: true, force: true });

    return {
      installed: true,
      kind: bundle.kind,
      slug: bundle.slug,
      version: bundle.version,
      path: activeRoot,
      restartRequired: bundle.kind === "MCP",
    };
  }

  private async registerMcp(bundle: ExtensionInstallBundle, activeRoot: string) {
    const entrypoint = bundle.manifest.entrypoint;
    if (typeof entrypoint !== "string") throw new Error("EXTENSION_MCP_ENTRYPOINT_INVALID");
    const entrypointPath = safeTarget(activeRoot, entrypoint);
    const tools = Array.isArray(bundle.manifest.tools)
      ? bundle.manifest.tools.flatMap((item) => item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string" ? [(item as { name: string }).name] : [])
      : [];
    const config = {
      enabled: true,
      transport: "stdio",
      command: process.execPath,
      args: [entrypointPath],
      cwd: activeRoot,
      connectTimeout: 5,
      timeout: 20,
      toolFilter: { include: tools },
    };
    try {
      await this.runOpenClaw(["mcp", "set", bundle.slug, JSON.stringify(config)], 15_000);
      await this.runOpenClaw(["mcp", "probe", bundle.slug], 20_000);
    } catch {
      await this.unregisterMcp(bundle.slug);
      throw new Error("EXTENSION_MCP_PROBE_FAILED");
    }
  }

  private async unregisterMcp(slug: string) {
    await this.runOpenClaw(["mcp", "unset", slug], 10_000).catch(() => undefined);
  }

  private async updateRegistry(bundle: ExtensionInstallBundle, activePath: string, archivePath: string) {
    const registryPath = path.join(this.stateDir, "fuduo-extensions.json");
    let registry: { schemaVersion: number; extensions: Record<string, unknown> } = { schemaVersion: 1, extensions: {} };
    try {
      const parsed = JSON.parse(await readFile(registryPath, "utf8")) as typeof registry;
      if (parsed?.schemaVersion === 1 && parsed.extensions && typeof parsed.extensions === "object") registry = parsed;
    } catch {}
    registry.extensions[bundle.slug] = {
      kind: bundle.kind,
      version: bundle.version,
      activePath,
      archivePath,
      manifest: bundle.manifest,
      installedAt: new Date().toISOString(),
    };
    const temporary = `${registryPath}.tmp`;
    await mkdir(path.dirname(registryPath), { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, registryPath);
  }
}

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readInstalledMcp(activeRoot: string): Promise<ExtensionInstallBundle | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(activeRoot, ".fuduo-extension.json"), "utf8")) as Record<string, unknown>;
    if (parsed.kind !== "MCP" || typeof parsed.slug !== "string" || !Number.isInteger(parsed.version) || !parsed.manifest || typeof parsed.manifest !== "object" || Array.isArray(parsed.manifest)) return null;
    return {
      kind: "MCP",
      slug: parsed.slug,
      version: parsed.version as number,
      manifest: parsed.manifest as Record<string, unknown>,
      files: [],
    };
  } catch {
    return null;
  }
}

async function writeBundle(root: string, bundle: ExtensionInstallBundle) {
  for (const file of bundle.files) {
    const target = safeTarget(root, file.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.content, { encoding: "utf8", mode: 0o600 });
  }
  await writeFile(path.join(root, ".fuduo-extension.json"), `${JSON.stringify({
    schemaVersion: 1,
    kind: bundle.kind,
    slug: bundle.slug,
    version: bundle.version,
    manifest: bundle.manifest,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function validateBundle(bundle: ExtensionInstallBundle) {
  if (!bundle || !["SKILL", "MCP"].includes(bundle.kind)) throw new Error("EXTENSION_BUNDLE_INVALID");
  if (!/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/.test(bundle.slug)) throw new Error("EXTENSION_BUNDLE_INVALID");
  if (!Number.isInteger(bundle.version) || bundle.version < 1) throw new Error("EXTENSION_BUNDLE_INVALID");
  if (!Array.isArray(bundle.files) || bundle.files.length < 1 || bundle.files.length > 12) throw new Error("EXTENSION_BUNDLE_INVALID");
  let bytes = 0;
  for (const file of bundle.files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw new Error("EXTENSION_BUNDLE_INVALID");
    safeTarget("/extension", file.path);
    bytes += Buffer.byteLength(file.content, "utf8");
  }
  if (bytes > 64 * 1024) throw new Error("EXTENSION_BUNDLE_TOO_LARGE");
}

function safeTarget(root: string, relative: string) {
  if (!/^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(relative) || relative.includes("..")) {
    throw new Error("EXTENSION_PATH_INVALID");
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relative);
  if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("EXTENSION_PATH_INVALID");
  return target;
}

function defaultOpenClawRunner(args: string[], timeoutMs = 15_000) {
  const entrypoint = fileURLToPath(new URL("../openclaw.mjs", import.meta.resolve("openclaw")));
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], {
      env: { ...process.env },
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("OPENCLAW_COMMAND_TIMEOUT"));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("OPENCLAW_COMMAND_FAILED"));
    });
  });
}
