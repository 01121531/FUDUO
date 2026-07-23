import { describe, expect, it, vi } from "vitest";
import { RedisSyncLease } from "./sync-lease.js";

describe("RedisSyncLease", () => {
  it("allows one owner and rejects a concurrent operation for the same key", async () => {
    const redis = new FakeRedis();
    const lease = new RedisSyncLease(redis as never, 300);
    let release!: () => void;
    const first = lease.run("sales:10218:2026-07-22", () => new Promise<void>((resolve) => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));

    await expect(lease.run("sales:10218:2026-07-22", async () => "duplicate")).rejects.toThrow("SYNC_LOCK_BUSY");
    release();
    await expect(first).resolves.toBeUndefined();
    expect(redis.values.size).toBe(0);
  });

  it("renews a running lease and releases it after completion", async () => {
    vi.useFakeTimers();
    try {
      const redis = new FakeRedis();
      const lease = new RedisSyncLease(redis as never, 30);
      let release!: () => void;
      const pending = lease.run("orders:10218:2026-07-22", () => new Promise<void>((resolve) => { release = resolve; }));
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15);

      expect(redis.renewals).toBeGreaterThanOrEqual(1);
      release();
      await expect(pending).resolves.toBeUndefined();
      expect(redis.values.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not delete a lease now owned by another worker", async () => {
    const redis = new FakeRedis();
    const lease = new RedisSyncLease(redis as never, 300);
    await expect(lease.run("refunds:10218:2026-07-22", async () => {
      redis.values.set("fuduo:sync-lease:refunds:10218:2026-07-22", "new-owner");
    })).rejects.toThrow("SYNC_LOCK_LOST");
    expect(redis.values.get("fuduo:sync-lease:refunds:10218:2026-07-22")).toBe("new-owner");
  });
});

class FakeRedis {
  readonly values = new Map<string, string>();
  renewals = 0;

  async set(key: string, value: string, _px: string, _ttl: number, _nx: string) {
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async eval(script: string, _keys: number, key: string, owner: string) {
    if (this.values.get(key) !== owner) return 0;
    if (script.includes("pexpire")) {
      this.renewals += 1;
      return 1;
    }
    this.values.delete(key);
    return 1;
  }
}
