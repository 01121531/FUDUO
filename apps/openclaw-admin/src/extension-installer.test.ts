import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionInstaller } from "./extension-installer.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ExtensionInstaller", () => {
  it("installs a Skill into the OpenClaw workspace and records its version", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "fuduo-extension-"));
    directories.push(state);
    const result = await new ExtensionInstaller(state).install({
      kind: "SKILL", slug: "weekly-review", version: 2, manifest: { tools: [] }, files: [{ path: "SKILL.md", content: "# Weekly review\n" }],
    });
    expect(result.restartRequired).toBe(false);
    await expect(readFile(path.join(state, "workspace", "skills", "weekly-review", "SKILL.md"), "utf8")).resolves.toBe("# Weekly review\n");
    const registry = JSON.parse(await readFile(path.join(state, "fuduo-extensions.json"), "utf8")) as { extensions: Record<string, { version: number }> };
    expect(registry.extensions["weekly-review"]?.version).toBe(2);
  });

  it("rejects files that escape the extension directory", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "fuduo-extension-"));
    directories.push(state);
    await expect(new ExtensionInstaller(state).install({
      kind: "MCP", slug: "unsafe-mcp", version: 1, manifest: {}, files: [{ path: "../outside.txt", content: "x" }],
    })).rejects.toThrow("EXTENSION_PATH_INVALID");
  });

  it("registers and probes an approved MCP server", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "fuduo-extension-"));
    directories.push(state);
    const runner = vi.fn(async () => undefined);
    const result = await new ExtensionInstaller(state, runner).install({
      kind: "MCP",
      slug: "order-helper",
      version: 1,
      manifest: { entrypoint: "server.mjs", tools: [{ name: "lookup_order" }] },
      files: [{ path: "server.mjs", content: "process.stdin.resume();\n" }],
    });
    expect(result.restartRequired).toBe(true);
    expect(runner).toHaveBeenNthCalledWith(1, ["mcp", "set", "order-helper", expect.stringContaining('"transport":"stdio"')], 15_000);
    expect(runner).toHaveBeenNthCalledWith(2, ["mcp", "probe", "order-helper"], 20_000);
  });

  it("withdraws a failed MCP registration and restores the previous version", async () => {
    const state = await mkdtemp(path.join(os.tmpdir(), "fuduo-extension-"));
    directories.push(state);
    let rejectNextProbe = false;
    const runner = vi.fn(async (args: string[]) => {
      if (rejectNextProbe && args[0] === "mcp" && args[1] === "probe") {
        rejectNextProbe = false;
        throw new Error("probe failed");
      }
    });
    const installer = new ExtensionInstaller(state, runner);
    const bundle = (version: number, content: string) => ({
      kind: "MCP" as const,
      slug: "order-helper",
      version,
      manifest: { entrypoint: "server.mjs", tools: [{ name: "lookup_order" }] },
      files: [{ path: "server.mjs", content }],
    });

    await installer.install(bundle(1, "// stable\n"));
    rejectNextProbe = true;
    await expect(installer.install(bundle(2, "// broken\n"))).rejects.toThrow("EXTENSION_MCP_PROBE_FAILED");

    await expect(readFile(path.join(state, "workspace", "mcp", "order-helper", "server.mjs"), "utf8")).resolves.toBe("// stable\n");
    const registry = JSON.parse(await readFile(path.join(state, "fuduo-extensions.json"), "utf8")) as { extensions: Record<string, { version: number }> };
    expect(registry.extensions["order-helper"]?.version).toBe(1);
    expect(runner).toHaveBeenCalledWith(["mcp", "unset", "order-helper"], 10_000);
    expect(runner).toHaveBeenLastCalledWith(["mcp", "probe", "order-helper"], 20_000);
  });
});
