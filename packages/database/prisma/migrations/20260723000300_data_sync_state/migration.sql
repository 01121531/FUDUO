CREATE TABLE "DataSyncState" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "dataType" TEXT NOT NULL,
    "tradeDate" DATE NOT NULL,
    "lastSuccessAt" TIMESTAMPTZ(3),
    "lastAttemptAt" TIMESTAMPTZ(3) NOT NULL,
    "lastAttemptStatus" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMPTZ(3),
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "currentAttemptKey" UUID,

    CONSTRAINT "DataSyncState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DataSyncState_shopId_dataType_tradeDate_key"
ON "DataSyncState"("shopId", "dataType", "tradeDate");

CREATE INDEX "DataSyncState_dataType_tradeDate_lastAttemptStatus_idx"
ON "DataSyncState"("dataType", "tradeDate", "lastAttemptStatus");

ALTER TABLE "DataSyncState"
ADD CONSTRAINT "DataSyncState_shopId_fkey"
FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve the freshness truth already present in the three daily tables. A
-- deterministic UUID keeps this migration independent from PostgreSQL
-- extensions such as pgcrypto.
INSERT INTO "DataSyncState" (
  "id", "shopId", "dataType", "tradeDate", "lastSuccessAt", "lastAttemptAt",
  "lastAttemptStatus", "source", "sourceUpdatedAt", "partial"
)
SELECT (md5('data-sync:sales:' || "shopId"::text || ':' || "tradeDate"::text))::uuid,
  "shopId", 'sales', "tradeDate", "fetchedAt", "fetchedAt", 'SUCCEEDED',
  "source", COALESCE("sourceUpdatedAt", "fetchedAt"),
  ("salesAmount" IS NULL OR "transactionCount" IS NULL)
FROM "SalesDaily";

INSERT INTO "DataSyncState" (
  "id", "shopId", "dataType", "tradeDate", "lastSuccessAt", "lastAttemptAt",
  "lastAttemptStatus", "source", "sourceUpdatedAt", "partial"
)
SELECT (md5('data-sync:orders:' || "shopId"::text || ':' || "tradeDate"::text))::uuid,
  "shopId", 'orders', "tradeDate", "fetchedAt", "fetchedAt", 'SUCCEEDED',
  "source", "fetchedAt", ("orderCount" IS NULL OR "paidAmount" IS NULL)
FROM "OrderDaily";

INSERT INTO "DataSyncState" (
  "id", "shopId", "dataType", "tradeDate", "lastSuccessAt", "lastAttemptAt",
  "lastAttemptStatus", "source", "sourceUpdatedAt", "partial"
)
SELECT (md5('data-sync:refunds:' || "shopId"::text || ':' || "tradeDate"::text))::uuid,
  "shopId", 'refunds', "tradeDate", "fetchedAt", "fetchedAt", 'SUCCEEDED',
  "source", "fetchedAt", ("refundAmount" IS NULL)
FROM "RefundDaily";

-- Overlay the newest persisted attempt so that a failure after a successful
-- fetch is immediately represented as STALE without deleting the good data.
WITH latest_attempt AS (
  SELECT DISTINCT ON (shop."id", item."dataType", item."tradeDate")
    shop."id" AS "shopId",
    item."dataType",
    item."tradeDate",
    COALESCE(item."finishedAt", item."startedAt") AS "attemptAt",
    CASE WHEN item."status" = 'RUNNING' THEN 'FAILED' ELSE item."status" END AS "attemptStatus",
    CASE WHEN item."status" = 'RUNNING' THEN 'SYNC_ATTEMPT_INTERRUPTED' ELSE item."errorCode" END AS "errorCode"
  FROM "SyncRunItem" item
  JOIN "Shop" shop ON shop."fuduoShopId" = item."fuduoShopId"
  WHERE item."dataType" IN ('sales', 'orders', 'refunds')
  ORDER BY shop."id", item."dataType", item."tradeDate", COALESCE(item."finishedAt", item."startedAt") DESC, item."createdAt" DESC
)
INSERT INTO "DataSyncState" (
  "id", "shopId", "dataType", "tradeDate", "lastSuccessAt", "lastAttemptAt",
  "lastAttemptStatus", "source", "sourceUpdatedAt", "partial", "errorCode"
)
SELECT (md5('data-sync:' || latest."dataType" || ':' || latest."shopId"::text || ':' || latest."tradeDate"::text))::uuid,
  latest."shopId", latest."dataType", latest."tradeDate", NULL, latest."attemptAt",
  latest."attemptStatus",
  CASE latest."dataType"
    WHEN 'sales' THEN 'FUDUO_SALES_LIVE'
    WHEN 'orders' THEN 'FUDUO_OPS_ORDERS'
    ELSE 'FUDUO_OPS_AFTERSALES'
  END,
  NULL, true, latest."errorCode"
FROM latest_attempt latest
ON CONFLICT ("shopId", "dataType", "tradeDate") DO UPDATE SET
  "lastAttemptAt" = EXCLUDED."lastAttemptAt",
  "lastAttemptStatus" = EXCLUDED."lastAttemptStatus",
  "errorCode" = EXCLUDED."errorCode",
  "partial" = "DataSyncState"."partial" OR EXCLUDED."lastAttemptStatus" = 'FAILED'
WHERE EXCLUDED."lastAttemptAt" >= "DataSyncState"."lastAttemptAt";
