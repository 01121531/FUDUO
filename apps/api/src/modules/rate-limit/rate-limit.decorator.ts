import { SetMetadata } from "@nestjs/common";

export const RATE_LIMIT_POLICY = Symbol("rate-limit-policy");

export type RateLimitIdentity = "ip" | "user" | "internal";

export interface RateLimitPolicy {
  name: string;
  limit: number;
  windowSeconds: number;
  identity: RateLimitIdentity;
  failOpen?: boolean;
}

export function RateLimit(policy: RateLimitPolicy) {
  if (!/^[a-z0-9-]{1,64}$/.test(policy.name)) throw new Error("RATE_LIMIT_POLICY_NAME_INVALID");
  if (!Number.isInteger(policy.limit) || policy.limit < 1) throw new Error("RATE_LIMIT_POLICY_LIMIT_INVALID");
  if (!Number.isInteger(policy.windowSeconds) || policy.windowSeconds < 1) throw new Error("RATE_LIMIT_POLICY_WINDOW_INVALID");
  return SetMetadata(RATE_LIMIT_POLICY, Object.freeze({ ...policy }));
}
