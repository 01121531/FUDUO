import { z } from "zod";

export const extensionKindSchema = z.enum(["SKILL", "MCP"]);
export type ExtensionKind = z.infer<typeof extensionKindSchema>;

const extensionFileSchema = z.object({
  path: z.string().min(1).max(120),
  content: z.string().max(32_000),
}).strict();

const extensionManifestSchema = z.object({
  entrypoint: z.string().max(120).optional(),
  tools: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
    description: z.string().min(1).max(500),
  }).strict()).max(12).default([]),
  permissions: z.object({
    networkHosts: z.array(z.string().max(253)).max(20).default([]),
    environment: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)).max(20).default([]),
    filesystem: z.array(z.string().max(120)).max(20).default([]),
  }).strict().default({ networkHosts: [], environment: [], filesystem: [] }),
}).strict();

export const extensionCandidateSchema = z.object({
  kind: extensionKindSchema,
  name: z.string().min(2).max(80),
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/),
  description: z.string().min(4).max(500),
  manifest: extensionManifestSchema,
  files: z.array(extensionFileSchema).min(1).max(12),
}).strict();

export type ExtensionCandidate = z.infer<typeof extensionCandidateSchema>;
export interface ExtensionValidation { errors: string[]; warnings: string[] }

const allowedFile = /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const forbiddenSource = [
  { pattern: /\b(?:eval|Function)\s*\(/, code: "DYNAMIC_CODE_EXECUTION" },
  { pattern: /(?:node:)?child_process|\bexecSync\b|\bspawnSync\b/, code: "PROCESS_EXECUTION" },
  { pattern: /\b(?:rm|rmdir|unlink)Sync\s*\(/, code: "DESTRUCTIVE_FILESYSTEM" },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, code: "EMBEDDED_PRIVATE_KEY" },
  { pattern: /(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{20,}/, code: "EMBEDDED_CREDENTIAL" },
] as const;

export function parseExtensionCandidate(raw?: string | null): ExtensionCandidate | null {
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const object = fenced ?? raw.match(/\{[\s\S]*\}/)?.[0];
  if (!object) return null;
  try {
    return extensionCandidateSchema.parse(JSON.parse(object));
  } catch {
    return null;
  }
}

export function validateExtensionCandidate(candidate: ExtensionCandidate): ExtensionValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const file of candidate.files) {
    if (!allowedFile.test(file.path) || file.path.includes("..") || file.path.startsWith("/")) errors.push(`INVALID_PATH:${file.path}`);
    const normalized = file.path.toLowerCase();
    if (seen.has(normalized)) errors.push(`DUPLICATE_PATH:${file.path}`);
    seen.add(normalized);
    totalBytes += Buffer.byteLength(file.content, "utf8");
    for (const rule of forbiddenSource) if (rule.pattern.test(file.content)) errors.push(`${rule.code}:${file.path}`);
  }
  if (totalBytes > 64 * 1024) errors.push("BUNDLE_TOO_LARGE");

  if (candidate.kind === "SKILL") {
    if (!seen.has("skill.md")) errors.push("SKILL_MD_REQUIRED");
    if (candidate.manifest.tools.length) warnings.push("SKILL_TOOLS_IGNORED");
  } else {
    if (!candidate.manifest.entrypoint || !seen.has(candidate.manifest.entrypoint.toLowerCase())) errors.push("MCP_ENTRYPOINT_REQUIRED");
    if (!candidate.manifest.tools.length) errors.push("MCP_TOOL_REQUIRED");
  }

  for (const host of candidate.manifest.permissions.networkHosts) {
    if (!isHostname(host)) errors.push(`INVALID_NETWORK_HOST:${host}`);
  }
  if (candidate.manifest.permissions.networkHosts.length) warnings.push("NETWORK_ACCESS_REQUIRES_REVIEW");
  if (candidate.manifest.permissions.environment.length) warnings.push("ENVIRONMENT_ACCESS_REQUIRES_REVIEW");
  if (candidate.manifest.permissions.filesystem.length) warnings.push("FILESYSTEM_ACCESS_REQUIRES_REVIEW");
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function fallbackExtensionCandidate(prompt: string, kindHint?: ExtensionKind): ExtensionCandidate {
  const kind: ExtensionKind = kindHint ?? (/\bmcp\b/i.test(prompt) ? "MCP" : "SKILL");
  const compact = prompt.replace(/\s+/g, " ").trim().slice(0, 240);
  const slug = `custom-${kind.toLowerCase()}-${simpleHash(compact)}`;
  const name = kind === "MCP" ? "Custom MCP Tool" : "Custom Assistant Skill";
  if (kind === "SKILL") {
    return extensionCandidateSchema.parse({
      kind,
      name,
      slug,
      description: compact || "A custom assistant skill generated from conversation.",
      manifest: { tools: [], permissions: { networkHosts: [], environment: [], filesystem: [] } },
      files: [{ path: "SKILL.md", content: `---\nname: ${slug}\ndescription: ${jsonLine(compact || name)}\n---\n\n# ${name}\n\n## Purpose\n\n${compact || "Follow the user's requested workflow."}\n\n## Rules\n\n- Ask for missing required inputs.\n- Do not request or expose credentials.\n- Summarize the result and any unresolved errors.\n` }],
    });
  }
  return extensionCandidateSchema.parse({
    kind,
    name,
    slug,
    description: compact || "A custom MCP server generated from conversation.",
    manifest: {
      entrypoint: "server.mjs",
      tools: [{ name: "describe_request", description: "Returns the approved MCP draft purpose and received input." }],
      permissions: { networkHosts: [], environment: [], filesystem: [] },
    },
    files: [
      { path: "manifest.json", content: JSON.stringify({ name: slug, version: "1.0.0", transport: "stdio" }, null, 2) },
      { path: "server.mjs", content: mcpServerSource(slug, compact || name) },
      { path: "README.md", content: `# ${name}\n\n${compact || "Generated MCP draft."}\n` },
    ],
  });
}

function isHostname(value: string) {
  return value.length <= 253 && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value);
}

function simpleHash(value: string) {
  let hash = 2166136261;
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36).slice(0, 8).padStart(6, "0");
}

function jsonLine(value: string) { return JSON.stringify(value); }

function mcpServerSource(slug: string, purpose: string) {
  return `import readline from "node:readline";
const serverInfo = { name: ${JSON.stringify(slug)}, version: "1.0.0" };
const purpose = ${JSON.stringify(purpose)};
const tools = [{ name: "describe_request", description: "Returns the approved MCP purpose and received input.", inputSchema: { type: "object", additionalProperties: true } }];
const input = readline.createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
input.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!Object.hasOwn(request, "id")) return;
  if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo } });
  if (request.method === "tools/list") return send({ jsonrpc: "2.0", id: request.id, result: { tools } });
  if (request.method === "tools/call") return send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify({ purpose, input: request.params?.arguments ?? {} }) }] } });
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
});
`;
}
