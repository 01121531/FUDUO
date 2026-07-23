import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scanner = resolve("scripts/scan-sensitive-output.mjs");

test("sensitive output scanner rejects plaintext credentials without echoing them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuduo-sensitive-scan-"));
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_value_123456";
  try {
    const file = join(directory, "runtime.log");
    await writeFile(file, `authorization: Bearer ${token}\n`, "utf8");
    const result = spawnSync(process.execPath, [scanner, file], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Bearer credential|JWT credential/);
    assert.doesNotMatch(result.stderr, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sensitive output scanner accepts redacted runtime logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuduo-sensitive-scan-"));
  try {
    const file = join(directory, "runtime.log");
    await writeFile(file, "authorization: Bearer [REDACTED]\ncookie=[REDACTED]\n", "utf8");
    const result = spawnSync(process.execPath, [scanner, file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /passed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("default scan only inspects runtime output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fuduo-sensitive-scan-"));
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_value_123456";
  try {
    await mkdir(join(directory, ".runtime"));
    await mkdir(join(directory, "artifacts"));
    await writeFile(join(directory, ".runtime", "runtime.log"), "authorization: Bearer [REDACTED]\n", "utf8");
    await writeFile(join(directory, "artifacts", "playwright-report.js"), `cookie=${token}\n`, "utf8");

    const result = spawnSync(process.execPath, [scanner], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /passed for 1 path/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
