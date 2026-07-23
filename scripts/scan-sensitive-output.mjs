import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";

const requested = process.argv.slice(2);
const roots = requested.length ? requested : [".runtime"];
const patterns = [
  { name: "Bearer credential", expression: /\bBearer\s+(?!\[REDACTED\])([A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?|[A-Za-z0-9._~-]{32,})/gi },
  { name: "JWT credential", expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "Cookie credential", expression: /\b(?:cookie|set-cookie)\s*[:=]\s*(?!\[REDACTED\])[^;\r\n]{20,}/gi },
];
const findings = [];

for (const root of roots) {
  const absolute = resolve(root);
  if (!await exists(absolute)) continue;
  for await (const file of walk(absolute)) await scan(file);
}

if (findings.length) {
  process.stderr.write(`Sensitive output scan failed with ${findings.length} finding(s):\n`);
  for (const finding of findings.slice(0, 100)) {
    process.stderr.write(`- ${finding.file}: ${finding.pattern} at byte ${finding.offset}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`Sensitive output scan passed for ${roots.length} path(s).\n`);
}

async function scan(file) {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size === 0) return;
  const stream = createReadStream(file);
  const input = extname(file).toLowerCase() === ".gz" ? stream.pipe(createGunzip()) : stream;
  let pending = "";
  let consumed = 0;
  try {
    for await (const chunk of input) {
      pending += Buffer.from(chunk).toString("latin1");
      for (const pattern of patterns) {
        pattern.expression.lastIndex = 0;
        for (const match of pending.matchAll(pattern.expression)) {
          findings.push({ file, pattern: pattern.name, offset: Math.max(0, consumed - pending.length + (match.index ?? 0)) });
        }
      }
      if (pending.length > 16_384) {
        consumed += pending.length - 8_192;
        pending = pending.slice(-8_192);
      }
      if (findings.length >= 100) return;
    }
  } catch (error) {
    throw new Error(`Cannot scan ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function* walk(path) {
  const metadata = await stat(path);
  if (metadata.isFile()) {
    yield path;
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    yield* walk(resolve(path, entry.name));
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
