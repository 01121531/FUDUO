import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateService, compareVersions } from "./update.service.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FUDUO_VERSION;
});

describe("UpdateService", () => {
  it("compares semantic release versions", () => {
    expect(compareVersions("v1.2.0", "v1.1.9")).toBeGreaterThan(0);
    expect(compareVersions("v1.2.0", "v1.2.0")).toBe(0);
    expect(compareVersions("v1.1.9", "v1.2.0")).toBeLessThan(0);
  });

  it("returns a validated GitHub release", async () => {
    process.env.FUDUO_VERSION = "v0.1.0";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      tag_name: "v0.2.0",
      name: "FUDUO v0.2.0",
      html_url: "https://github.com/01121531/FUDUO/releases/tag/v0.2.0",
      published_at: "2026-07-24T00:00:00.000Z",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const result = await new UpdateService().status() as { updateAvailable: boolean; latestVersion: string };
    expect(result).toMatchObject({ updateAvailable: true, latestVersion: "v0.2.0" });
  });
});
