import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { Prisma } from "@fuduo/database";
import { DatabaseService } from "../database/database.service.js";

export interface InboundInvocationIdentity {
  channel: string;
  accountId: string;
  externalMessageId: string;
}

interface InvocationInput {
  name: string;
  params: unknown;
  userId?: string;
}

@Injectable()
export class ToolInvocationDeduplicator {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async run<T>(identity: InboundInvocationIdentity | undefined, input: InvocationInput, execute: () => Promise<T>): Promise<T> {
    if (!identity || !this.database.enabled) return execute();
    const operationKey = operationHash(input);
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + 2 * 60_000);
    const unique = { ...identity, operationKey };
    let invocationId: string | undefined;

    try {
      const created = await this.database.prisma.inboundToolInvocation.create({
        data: { ...unique, toolName: input.name, leaseToken, leaseExpiresAt },
      });
      invocationId = created.id;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    if (!invocationId) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const existing = await this.database.prisma.inboundToolInvocation.findUnique({
          where: { channel_accountId_externalMessageId_operationKey: unique },
        });
        if (!existing) continue;
        if (existing.status === "SUCCEEDED") return existing.response as T;
        const reclaimed = await this.database.prisma.inboundToolInvocation.updateMany({
          where: {
            id: existing.id,
            OR: [
              { status: "FAILED" },
              { status: "PROCESSING", leaseExpiresAt: { lte: new Date() } },
            ],
          },
          data: { status: "PROCESSING", response: Prisma.JsonNull, errorCode: null, leaseToken, leaseExpiresAt },
        });
        if (reclaimed.count === 1) {
          invocationId = existing.id;
          break;
        }
        throw new ConflictException("相同微信消息正在处理中，请稍后重试");
      }
    }
    if (!invocationId) throw new ConflictException("相同微信消息正在处理中，请稍后重试");

    try {
      const result = await execute();
      const completed = await this.database.prisma.inboundToolInvocation.updateMany({
        where: { id: invocationId, leaseToken },
        data: { status: "SUCCEEDED", response: toJson(result), errorCode: null, leaseToken: null, leaseExpiresAt: null },
      });
      if (completed.count !== 1) throw new Error("TOOL_INVOCATION_LEASE_LOST");
      return result;
    } catch (error) {
      await this.database.prisma.inboundToolInvocation.updateMany({
        where: { id: invocationId, leaseToken },
        data: { status: "FAILED", errorCode: codeOf(error), leaseToken: null, leaseExpiresAt: null },
      }).catch(() => undefined);
      throw error;
    }
  }
}

export function parseInboundInvocationIdentity(values: {
  channel?: string | undefined;
  accountId?: string | undefined;
  externalMessageId?: string | undefined;
}): InboundInvocationIdentity | undefined {
  const supplied = [values.channel, values.accountId, values.externalMessageId].some((value) => value !== undefined);
  if (!supplied) return undefined;
  const channel = normalized(values.channel, 100);
  const accountId = normalized(values.accountId, 200);
  const externalMessageId = normalized(values.externalMessageId, 512);
  if (!channel || !accountId || !externalMessageId) throw new BadRequestException("入站消息标识无效");
  return { channel, accountId, externalMessageId };
}

function operationHash(input: InvocationInput): string {
  return createHash("sha256").update(canonicalJson({ name: input.name, params: input.params, userId: input.userId ?? null })).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function normalized(value: string | undefined, maxLength: number) {
  const result = value?.trim();
  return result && result.length <= maxLength ? result : undefined;
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "P2002");
}

function codeOf(error: unknown) {
  return error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "TOOL_FAILED";
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}
