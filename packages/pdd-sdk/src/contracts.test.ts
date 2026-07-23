import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PddClient } from "./index";

type ContractId = "generic-response-success";

interface ContractEntry {
  id: ContractId;
  scope: string;
  file: string;
  provenance: "synthetic-redacted" | "observed-redacted";
  realResponseVerified: boolean;
  capturedAt: string | null;
  observedClientVersion: string | null;
}

interface PddContractManifest {
  schemaVersion: number;
  status: string;
  contracts: ContractEntry[];
  evidenceGaps: string[];
}

const syntheticResponseSchema = z.object({
  success: z.literal(true),
  result: z.object({
    requestId: z.string().startsWith("fixture-"),
    records: z.array(
      z.object({
        entityId: z.string().regex(/^ENTITY_REDACTED_\d+$/),
        amount: z.coerce.number().nonnegative(),
        status: z.string(),
      }),
    ),
    total: z.number().int().nonnegative(),
  }),
});

const contractsDirectory = new URL("../contracts/", import.meta.url);
const manifest = readJson<PddContractManifest>(
  new URL("manifest.json", contractsDirectory),
);

describe("synthetic redacted PDD response contract", () => {
  it("records synthetic evidence without claiming a live PDD response shape", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.status).toBe(
      "synthetic-only-awaiting-observed-redacted-response",
    );
    expect(manifest.contracts).toHaveLength(1);
    expect(manifest.evidenceGaps).toHaveLength(3);

    const [entry] = manifest.contracts;
    expect(entry).toMatchObject({
      id: "generic-response-success",
      scope: "caller-supplied schema parsing",
      provenance: "synthetic-redacted",
      realResponseVerified: false,
      capturedAt: null,
      observedClientVersion: null,
    });
    expect(entry.file).toMatch(/^fixtures\/[a-z0-9.-]+\.json$/);
    expect(syntheticResponseSchema.safeParse(fixture(entry)).success).toBe(
      true,
    );
    expect(JSON.stringify(fixture(entry))).not.toMatch(
      /(?:authorization|cookie|set-cookie|access[_-]?token|eyJ[A-Za-z0-9_-]+\.)/i,
    );
  });

  it("parses the local fixture through the exported request API without network access", async () => {
    const fixtureResponse = fixture(manifest.contracts[0]);
    const transport = vi.fn(async () =>
      new Response(JSON.stringify(fixtureResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new PddClient({
      getSession: () => ({
        cookie: "[REDACTED_COOKIE]",
        userAgent: "FixtureBrowser/1.0",
      }),
      transport,
    });

    await expect(
      client.request({
        path: "/fixture-contract-only",
        schema: syntheticResponseSchema,
      }),
    ).resolves.toEqual({
      success: true,
      result: {
        requestId: "fixture-request-not-live",
        records: [
          {
            entityId: "ENTITY_REDACTED_001",
            amount: 88.5,
            status: "FIXTURE_READY",
          },
        ],
        total: 1,
      },
    });
    expect(transport).toHaveBeenCalledOnce();
  });
});

function fixture(entry: ContractEntry): unknown {
  return readJson(new URL(entry.file, contractsDirectory));
}

function readJson<T = unknown>(url: URL): T {
  return JSON.parse(readFileSync(url, "utf8")) as T;
}
