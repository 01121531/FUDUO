import { randomUUID } from "node:crypto";
import type IORedis from "ioredis";

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export interface SyncLease {
  run<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export class RedisSyncLease implements SyncLease {
  constructor(
    private readonly redis: IORedis,
    private readonly ttlMs = 5 * 60_000,
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs < 30) throw new Error("SYNC_LEASE_TTL_INVALID");
  }

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (!/^[a-z][a-z0-9-]*:\d+:\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error("SYNC_LEASE_KEY_INVALID");
    const redisKey = `fuduo:sync-lease:${key}`;
    const owner = randomUUID();
    const acquired = await this.redis.set(redisKey, owner, "PX", this.ttlMs, "NX");
    if (acquired !== "OK") throw new Error("SYNC_LOCK_BUSY");

    let renewalFailed = false;
    const renewal = setInterval(() => {
      void this.redis.eval(RENEW_SCRIPT, 1, redisKey, owner, String(this.ttlMs))
        .then((result) => { if (Number(result) !== 1) renewalFailed = true; })
        .catch(() => { renewalFailed = true; });
    }, Math.max(10, Math.floor(this.ttlMs / 3)));
    renewal.unref();

    try {
      const result = await operation();
      if (renewalFailed) throw new Error("SYNC_LOCK_LOST");
      const stillOwned = await this.redis.eval(RENEW_SCRIPT, 1, redisKey, owner, String(this.ttlMs))
        .catch(() => 0);
      if (Number(stillOwned) !== 1) throw new Error("SYNC_LOCK_LOST");
      return result;
    } finally {
      clearInterval(renewal);
      await this.redis.eval(RELEASE_SCRIPT, 1, redisKey, owner).catch(() => undefined);
    }
  }
}

export const noSyncLease: SyncLease = {
  run: (_key, operation) => operation(),
};
