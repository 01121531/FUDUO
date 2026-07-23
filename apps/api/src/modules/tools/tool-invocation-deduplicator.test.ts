import { describe, expect, it, vi } from "vitest";
import { parseInboundInvocationIdentity, ToolInvocationDeduplicator } from "./tool-invocation-deduplicator.js";

interface InvocationRecord {
  id: string;
  channel: string;
  accountId: string;
  externalMessageId: string;
  operationKey: string;
  toolName: string;
  status: string;
  response: unknown;
  errorCode: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
}

const identity = {
  channel: "openclaw-weixin",
  accountId: "account-1",
  externalMessageId: "message-1",
};

describe("ToolInvocationDeduplicator", () => {
  it("executes an operation once and replays its persisted response", async () => {
    const database = fakeDatabase();
    const deduplicator = new ToolInvocationDeduplicator(database as never);
    const execute = vi.fn(async () => ({ total: 42 }));

    await expect(deduplicator.run(identity, {
      name: "get_sales_summary",
      params: { startDate: "2026-07-01", shopIds: ["shop-1"] },
      userId: "employee-1",
    }, execute)).resolves.toEqual({ total: 42 });
    await expect(deduplicator.run(identity, {
      name: "get_sales_summary",
      params: { shopIds: ["shop-1"], startDate: "2026-07-01" },
      userId: "employee-1",
    }, execute)).resolves.toEqual({ total: 42 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(database.records).toHaveLength(1);
    expect(database.records[0]?.status).toBe("SUCCEEDED");
  });

  it("treats different operations in the same inbound message independently", async () => {
    const database = fakeDatabase();
    const deduplicator = new ToolInvocationDeduplicator(database as never);
    const execute = vi.fn(async () => ({ ok: true }));

    await deduplicator.run(identity, { name: "get_shop_sales", params: { shopId: "shop-1" } }, execute);
    await deduplicator.run(identity, { name: "get_shop_sales", params: { shopId: "shop-2" } }, execute);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(database.records).toHaveLength(2);
  });

  it("rejects a concurrent duplicate while the first lease is active", async () => {
    const database = fakeDatabase();
    const deduplicator = new ToolInvocationDeduplicator(database as never);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = deduplicator.run(identity, { name: "list_shops", params: {} }, async () => {
      await blocked;
      return { ok: true };
    });
    await vi.waitFor(() => expect(database.records).toHaveLength(1));

    await expect(deduplicator.run(identity, { name: "list_shops", params: {} }, vi.fn()))
      .rejects.toMatchObject({ status: 409 });

    release();
    await expect(first).resolves.toEqual({ ok: true });
  });

  it("reclaims a failed invocation so a redelivery can retry", async () => {
    const database = fakeDatabase();
    const deduplicator = new ToolInvocationDeduplicator(database as never);

    await expect(deduplicator.run(identity, { name: "list_shops", params: {} }, async () => {
      throw new Error("UPSTREAM_UNAVAILABLE");
    })).rejects.toThrow("UPSTREAM_UNAVAILABLE");

    await expect(deduplicator.run(identity, { name: "list_shops", params: {} }, async () => ({ ok: true })))
      .resolves.toEqual({ ok: true });
    expect(database.records[0]?.status).toBe("SUCCEEDED");
  });

  it("bypasses persistence when no complete inbound identity is available", async () => {
    const database = fakeDatabase();
    const deduplicator = new ToolInvocationDeduplicator(database as never);
    const execute = vi.fn(async () => "ok");

    await expect(deduplicator.run(undefined, { name: "list_shops", params: {} }, execute)).resolves.toBe("ok");
    expect(database.records).toHaveLength(0);
  });
});

describe("parseInboundInvocationIdentity", () => {
  it("accepts a complete trimmed identity", () => {
    expect(parseInboundInvocationIdentity({
      channel: " openclaw-weixin ",
      accountId: " account-1 ",
      externalMessageId: " message-1 ",
    })).toEqual(identity);
  });

  it("rejects partial or oversized identities as a bad request", () => {
    expect(() => parseInboundInvocationIdentity({ channel: "openclaw-weixin" })).toThrow("入站消息标识无效");
    expect(() => parseInboundInvocationIdentity({
      channel: "openclaw-weixin",
      accountId: "account-1",
      externalMessageId: "x".repeat(513),
    })).toThrow("入站消息标识无效");
  });
});

function fakeDatabase() {
  const records: InvocationRecord[] = [];
  let id = 0;
  return {
    enabled: true,
    records,
    prisma: {
      inboundToolInvocation: {
        create: async ({ data }: { data: Omit<InvocationRecord, "id" | "status" | "response" | "errorCode"> }) => {
          const duplicate = records.some((record) => sameUnique(record, data));
          if (duplicate) throw Object.assign(new Error("duplicate"), { code: "P2002" });
          const record: InvocationRecord = {
            ...data,
            id: `invocation-${++id}`,
            status: "PROCESSING",
            response: null,
            errorCode: null,
          };
          records.push(record);
          return { ...record };
        },
        findUnique: async ({ where }: { where: { channel_accountId_externalMessageId_operationKey: InvocationRecord } }) => {
          const unique = where.channel_accountId_externalMessageId_operationKey;
          const record = records.find((candidate) => sameUnique(candidate, unique));
          return record ? { ...record } : null;
        },
        updateMany: async ({ where, data }: {
          where: { id: string; leaseToken?: string; OR?: Array<{ status: string; leaseExpiresAt?: { lte: Date } }> };
          data: Partial<InvocationRecord>;
        }) => {
          const record = records.find((candidate) => candidate.id === where.id);
          if (!record || (where.leaseToken !== undefined && record.leaseToken !== where.leaseToken)) return { count: 0 };
          if (where.OR) {
            const matches = where.OR.some((condition) => condition.status === record.status
              && (!condition.leaseExpiresAt || Boolean(record.leaseExpiresAt && record.leaseExpiresAt <= condition.leaseExpiresAt.lte)));
            if (!matches) return { count: 0 };
          }
          Object.assign(record, data);
          return { count: 1 };
        },
      },
    },
  };
}

function sameUnique(left: Pick<InvocationRecord, "channel" | "accountId" | "externalMessageId" | "operationKey">, right: Pick<InvocationRecord, "channel" | "accountId" | "externalMessageId" | "operationKey">) {
  return left.channel === right.channel
    && left.accountId === right.accountId
    && left.externalMessageId === right.externalMessageId
    && left.operationKey === right.operationKey;
}
