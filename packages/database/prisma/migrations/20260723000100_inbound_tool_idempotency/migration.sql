CREATE TABLE "InboundToolInvocation" (
    "id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "externalMessageId" TEXT NOT NULL,
    "operationKey" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "response" JSONB,
    "errorCode" TEXT,
    "leaseToken" UUID,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundToolInvocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InboundToolInvocation_channel_accountId_externalMessageId_operationKey_key"
ON "InboundToolInvocation"("channel", "accountId", "externalMessageId", "operationKey");

CREATE INDEX "InboundToolInvocation_status_leaseExpiresAt_idx"
ON "InboundToolInvocation"("status", "leaseExpiresAt");

CREATE INDEX "InboundToolInvocation_createdAt_idx"
ON "InboundToolInvocation"("createdAt");
