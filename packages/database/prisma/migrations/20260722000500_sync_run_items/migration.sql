CREATE TABLE "SyncRunItem" (
  "id" UUID NOT NULL,
  "syncRunId" UUID NOT NULL,
  "dataType" TEXT NOT NULL,
  "tradeDate" DATE NOT NULL,
  "fuduoShopId" BIGINT NOT NULL,
  "shopName" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SyncRunItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SyncRunItem_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "SyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SyncRunItem_syncRunId_dataType_tradeDate_fuduoShopId_key"
  ON "SyncRunItem"("syncRunId", "dataType", "tradeDate", "fuduoShopId");
CREATE INDEX "SyncRunItem_syncRunId_tradeDate_dataType_idx"
  ON "SyncRunItem"("syncRunId", "tradeDate", "dataType");
CREATE INDEX "SyncRunItem_fuduoShopId_tradeDate_idx"
  ON "SyncRunItem"("fuduoShopId", "tradeDate");
