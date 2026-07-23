import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  envelopeSchema,
  meSchema,
  merchantBackendPrepareSchema,
  opsAfterSalesPageSchema,
  opsOrderPageSchema,
  qrLoginPollSchema,
  qrLoginSchema,
  refreshSessionSchema,
  salesLiveSchema,
  visibleShopPageSchema,
} from "./schemas";
import { FuduoClient } from "./index";

type FixtureId =
  | "qr-login-success"
  | "qr-login-poll-success"
  | "iam-me-success"
  | "visible-shops-success"
  | "session-refresh-success"
  | "sales-live-success"
  | "orders-list-success"
  | "aftersales-list-success"
  | "merchant-backend-prepare-success";

interface ContractEntry {
  id: FixtureId;
  endpoint: string;
  file: string;
  provenance: "synthetic-redacted" | "observed-redacted";
  realResponseVerified: boolean;
  capturedAt: string | null;
  observedClientVersion: string | null;
}

interface ContractManifest {
  schemaVersion: number;
  fixtures: ContractEntry[];
}

const contractsDirectory = new URL("../contracts/", import.meta.url);
const manifest = readJson<ContractManifest>(
  new URL("manifest.json", contractsDirectory),
);
const entries = new Map(manifest.fixtures.map((entry) => [entry.id, entry]));
const schemas = {
  "qr-login-success": qrLoginSchema,
  "qr-login-poll-success": qrLoginPollSchema,
  "iam-me-success": meSchema,
  "visible-shops-success": visibleShopPageSchema,
  "session-refresh-success": refreshSessionSchema,
  "sales-live-success": salesLiveSchema,
  "orders-list-success": opsOrderPageSchema,
  "aftersales-list-success": opsAfterSalesPageSchema,
  "merchant-backend-prepare-success": merchantBackendPrepareSchema,
} as const;

describe("redacted Fuduo response contracts", () => {
  it("registers every currently implemented business response parser", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect([...entries.keys()].sort()).toEqual(Object.keys(schemas).sort());
  });

  it.each(manifest.fixtures)(
    "$endpoint fixture matches its envelope and evidence metadata",
    (entry) => {
      const raw = fixture(entry.id);
      expect(envelopeSchema(schemas[entry.id]).safeParse(raw).success).toBe(
        true,
      );
      expect(entry.file).toMatch(/^fixtures\/[a-z0-9.-]+\.json$/);
      if (entry.provenance === "observed-redacted") {
        expect(entry.realResponseVerified).toBe(true);
        expect(entry.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(entry.observedClientVersion).toBeTruthy();
      } else {
        expect(entry.realResponseVerified).toBe(false);
        expect(entry.capturedAt).toBeNull();
        expect(entry.observedClientVersion).toBeNull();
      }
      expectSensitiveValuesRedacted(raw);
    },
  );

  it("normalizes numeric strings and preserves intentional nulls", () => {
    const sales = parseData("sales-live-success");
    expect(sales).toMatchObject({
      shopId: 10001,
      salesAmount: 1288.5,
      transactionCount: 42,
      yesterdayVisitorValue: null,
    });

    const orders = parseData("orders-list-success");
    expect(orders).toMatchObject({
      total: 2,
      page: 1,
      records: [{ payAmount: 88.5 }, { payAmount: null }],
    });

    const afterSales = parseData("aftersales-list-success");
    expect(afterSales).toMatchObject({
      total: 2,
      records: [
        { refundAmount: 18.25, performanceImpact: -18.25 },
        { refundAmount: null },
      ],
    });
  });

  it("drives all client methods through the registered response contracts", async () => {
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const id = fixtureForRequest(method, url);
        return new Response(JSON.stringify(fixture(id)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    const client = new FuduoClient({
      getAccessToken: () => "[REDACTED_ACCESS_TOKEN]",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.getQrLogin()).resolves.toMatchObject({
      state: "fixture-state-not-live",
    });
    await expect(
      client.pollQrLogin("fixture-state-not-live"),
    ).resolves.toMatchObject({
      pollStatus: "SUCCESS",
      login: { accessToken: "[REDACTED_ACCESS_TOKEN]" },
    });
    await expect(client.getMe()).resolves.toMatchObject({
      id: "fixture-user-001",
    });
    await expect(client.listVisibleShops()).resolves.toMatchObject({
      total: 2,
    });
    await expect(client.refreshSession()).resolves.toBe(
      "[REDACTED_ACCESS_TOKEN]",
    );
    await expect(
      client.getSalesLive(10001, "2026-07-21"),
    ).resolves.toMatchObject({ salesAmount: 1288.5 });
    await expect(
      client.listOrders(
        10001,
        "2026-07-21T00:00:00+08:00",
        "2026-07-21T23:59:59.999+08:00",
      ),
    ).resolves.toMatchObject({ total: 2 });
    await expect(
      client.listAfterSales(
        10001,
        "2026-07-21T00:00:00+08:00",
        "2026-07-21T23:59:59.999+08:00",
      ),
    ).resolves.toMatchObject({ total: 2 });
    await expect(client.prepareMerchantBackend(20001)).resolves.toMatchObject({
      action: "READY",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(9);
  });
});

function fixture(id: FixtureId): unknown {
  const entry = entries.get(id);
  if (!entry) throw new Error(`Missing contract entry: ${id}`);
  return readJson(new URL(entry.file, contractsDirectory));
}

function parseData<T extends FixtureId>(id: T) {
  const raw = fixture(id);
  return envelopeSchema(schemas[id]).parse(raw).data!;
}

function readJson<T = unknown>(url: URL): T {
  return JSON.parse(readFileSync(url, "utf8")) as T;
}

function fixtureForRequest(method: string, url: URL): FixtureId {
  if (method === "GET" && url.pathname === "/api/v1/auth/wecom/qr-url")
    return "qr-login-success";
  if (method === "GET" && url.pathname === "/api/v1/auth/wecom/poll") {
    expect(url.searchParams.get("state")).toBe("fixture-state-not-live");
    return "qr-login-poll-success";
  }
  if (method === "GET" && url.pathname === "/api/v1/iam/me")
    return "iam-me-success";
  if (method === "GET" && url.pathname === "/api/v1/shops/visible/page") {
    expect(url.searchParams.get("enrichMode")).toBe("FULL");
    return "visible-shops-success";
  }
  if (method === "POST" && url.pathname === "/api/v1/auth/session/refresh")
    return "session-refresh-success";
  if (method === "GET" && url.pathname === "/api/v1/shops/10001/sales-live") {
    expect(url.searchParams.get("tradeDate")).toBe("2026-07-21");
    return "sales-live-success";
  }
  if (method === "POST" && url.pathname === "/api/v1/ops/orders/list")
    return "orders-list-success";
  if (method === "POST" && url.pathname === "/api/v1/ops/aftersales/list")
    return "aftersales-list-success";
  if (
    method === "POST" &&
    url.pathname === "/api/v1/shop-accounts/20001/merchant-backend-prepare"
  ) {
    return "merchant-backend-prepare-success";
  }
  throw new Error(`No fixture for ${method} ${url.pathname}`);
}

function expectSensitiveValuesRedacted(value: unknown, key = ""): void {
  if (typeof value === "string") {
    expect(value).not.toMatch(/\bBearer\s+(?!\[REDACTED\])/i);
    expect(value).not.toMatch(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    );
    if (/authorization|accessToken|cookie|cookieSnapshot/i.test(key)) {
      expect(value).toMatch(/^\[REDACTED(?:_[A-Z_]+)?\]$/);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) expectSensitiveValuesRedacted(item, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      expectSensitiveValuesRedacted(childValue, childKey);
    }
  }
}
