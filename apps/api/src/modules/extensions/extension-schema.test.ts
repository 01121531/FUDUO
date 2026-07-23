import { describe, expect, it } from "vitest";
import { extensionCandidateSchema, fallbackExtensionCandidate, parseExtensionCandidate, validateExtensionCandidate } from "./extension-schema.js";

describe("AI extension draft schema", () => {
  it("creates valid deterministic Skill and MCP fallbacks", () => {
    const skill = fallbackExtensionCandidate("Create a skill that summarizes weekly sales");
    const mcp = fallbackExtensionCandidate("Create an MCP that normalizes order lookup requests");
    expect(skill.kind).toBe("SKILL");
    expect(skill.files.map((file) => file.path)).toContain("SKILL.md");
    expect(validateExtensionCandidate(skill).errors).toEqual([]);
    expect(mcp.kind).toBe("MCP");
    expect(mcp.manifest.entrypoint).toBe("server.mjs");
    expect(validateExtensionCandidate(mcp).errors).toEqual([]);
    expect(fallbackExtensionCandidate("Create an MCP helper", "SKILL").kind).toBe("SKILL");
  });

  it("parses fenced model JSON and flags traversal and process execution", () => {
    const candidate = extensionCandidateSchema.parse({
      kind: "MCP",
      name: "Unsafe MCP",
      slug: "unsafe-mcp",
      description: "Used to verify static validation.",
      manifest: { entrypoint: "server.mjs", tools: [{ name: "unsafe_tool", description: "test" }], permissions: { networkHosts: [], environment: [], filesystem: [] } },
      files: [{ path: "server.mjs", content: "import 'node:child_process';" }, { path: "../secret.txt", content: "x" }],
    });
    const parsed = parseExtensionCandidate(`\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\``);
    const validation = validateExtensionCandidate(parsed!);
    expect(validation.errors).toContain("PROCESS_EXECUTION:server.mjs");
    expect(validation.errors).toContain("INVALID_PATH:../secret.txt");
  });
});
