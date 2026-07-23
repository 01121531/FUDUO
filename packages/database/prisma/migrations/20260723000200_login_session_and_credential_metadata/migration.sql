ALTER TABLE "ErpCredential"
  ADD COLUMN "accountName" TEXT,
  ADD COLUMN "shopCount" INTEGER;

CREATE TABLE "LoginSession" (
  "id" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "status" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "accountName" TEXT,
  "shopCount" INTEGER,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "errorRecovery" TEXT,
  "finishedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LoginSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LoginSession_ownerId_status_idx" ON "LoginSession"("ownerId", "status");
CREATE INDEX "LoginSession_status_expiresAt_idx" ON "LoginSession"("status", "expiresAt");
CREATE INDEX "LoginSession_updatedAt_idx" ON "LoginSession"("updatedAt");

ALTER TABLE "LoginSession"
  ADD CONSTRAINT "LoginSession_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
