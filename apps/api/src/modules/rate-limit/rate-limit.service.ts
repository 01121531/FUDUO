import { createHash } from "node:crypto";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import IORedis from "ioredis";
import { DatabaseService } from "../database/database.service.js";
import type { RateLimitPolicy } from "./rate-limit.decorator.js";

const REDIS_SCRIPT = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("TTL", KEYS[1])
return { current, ttl }
`;

const MAX_MEMORY_KEYS = 10_000;

interface MemoryWindow {
  count: number;
  expiresAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export class RateLimitBackendError extends Error {
  constructor() {
    super("RATE_LIMIT_BACKEND_UNAVAILABLE");
  }
}

@Injectable()
export class RateLimitService implements OnApplicationShutdown {
  private readonly memory = new Map<string, MemoryWindow>();
  private connection: IORedis | null = null;
  private operations = 0;

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async consume(policy: RateLimitPolicy, identity: string, now = Date.now()): Promise<RateLimitResult> {
    const key = buildRateLimitKey(policy.name, identity);
    if (!this.database.enabled) return this.consumeMemory(key, policy, now);

    try {
      const connection = this.getConnection();
      if (connection.status === "wait") await connection.connect();
      const result = await connection.eval(REDIS_SCRIPT, 1, key, String(policy.windowSeconds));
      if (!Array.isArray(result) || result.length !== 2) throw new Error("invalid rate limit response");
      const count = Number(result[0]);
      const ttl = Number(result[1]);
      if (!Number.isFinite(count) || !Number.isFinite(ttl)) throw new Error("invalid rate limit counters");
      return toResult(count, policy.limit, ttl > 0 ? ttl : policy.windowSeconds);
    } catch {
      throw new RateLimitBackendError();
    }
  }

  async onApplicationShutdown() {
    if (this.connection) await this.connection.quit();
  }

  private consumeMemory(key: string, policy: RateLimitPolicy, now: number): RateLimitResult {
    this.operations += 1;
    if (this.operations % 256 === 0 || this.memory.size >= MAX_MEMORY_KEYS) this.pruneMemory(now);

    const existing = this.memory.get(key);
    const entry = !existing || existing.expiresAt <= now
      ? { count: 1, expiresAt: now + policy.windowSeconds * 1_000 }
      : { count: existing.count + 1, expiresAt: existing.expiresAt };
    this.memory.set(key, entry);
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.expiresAt - now) / 1_000));
    return toResult(entry.count, policy.limit, retryAfterSeconds);
  }

  private pruneMemory(now: number) {
    for (const [key, entry] of this.memory) {
      if (entry.expiresAt <= now) this.memory.delete(key);
    }
    while (this.memory.size >= MAX_MEMORY_KEYS) {
      const oldest = this.memory.keys().next().value as string | undefined;
      if (!oldest) break;
      this.memory.delete(oldest);
    }
  }

  private getConnection() {
    if (this.connection) return this.connection;
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) throw new RateLimitBackendError();
    this.connection = new IORedis(redisUrl, {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2_000,
      commandTimeout: 2_000,
    });
    this.connection.on("error", () => undefined);
    return this.connection;
  }
}

export function buildRateLimitKey(policyName: string, identity: string) {
  const digest = createHash("sha256").update(`fuduo-rate-limit-v1\0${identity}`).digest("hex");
  return `rate-limit:v1:${policyName}:${digest}`;
}

function toResult(count: number, limit: number, retryAfterSeconds: number): RateLimitResult {
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
  };
}
