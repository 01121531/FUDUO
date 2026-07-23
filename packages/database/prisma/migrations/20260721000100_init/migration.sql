-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CredentialStatus" AS ENUM ('UNCONFIGURED', 'LOGIN_PENDING', 'ACTIVE', 'REFRESHING', 'REAUTH_REQUIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "Freshness" AS ENUM ('LIVE', 'RECENT', 'STALE', 'UNKNOWN');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "totpSecretCipher" BYTEA,
    "totpSecretIv" BYTEA,
    "totpSecretTag" BYTEA,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "ErpCredential" (
    "id" UUID NOT NULL,
    "singletonKey" TEXT NOT NULL DEFAULT 'primary',
    "status" "CredentialStatus" NOT NULL DEFAULT 'UNCONFIGURED',
    "issuer" TEXT,
    "subject" TEXT,
    "userId" TEXT,
    "accessTokenCipher" BYTEA,
    "accessTokenIv" BYTEA,
    "accessTokenTag" BYTEA,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3),
    "lastRefreshedAt" TIMESTAMPTZ(3),
    "lastVerifiedAt" TIMESTAMPTZ(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ErpCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" UUID NOT NULL,
    "fuduoShopId" BIGINT NOT NULL,
    "fuduoAccountId" BIGINT,
    "platformShopId" TEXT,
    "platformCode" TEXT NOT NULL DEFAULT 'pdd',
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "loginStatus" TEXT,
    "lastVisibleAt" TIMESTAMPTZ(3),
    "lastSyncedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopAccount" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "externalAccountId" BIGINT NOT NULL,
    "platformShopId" TEXT,
    "loginStatus" TEXT,
    "lastPreparedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ShopAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDaily" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "tradeDate" DATE NOT NULL,
    "salesAmount" DECIMAL(20,2),
    "transactionCount" INTEGER,
    "payBuyerCount" INTEGER,
    "averageOrderValue" DECIMAL(20,2),
    "refundAmount" DECIMAL(20,2),
    "freshness" "Freshness" NOT NULL DEFAULT 'UNKNOWN',
    "source" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMPTZ(3),
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "SalesDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesSnapshot" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "tradeDate" DATE NOT NULL,
    "salesAmount" DECIMAL(20,2),
    "transactionCount" INTEGER,
    "refundAmount" DECIMAL(20,2),
    "source" TEXT NOT NULL,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderDaily" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "tradeDate" DATE NOT NULL,
    "orderCount" INTEGER,
    "paidOrderCount" INTEGER,
    "paidAmount" DECIMAL(20,2),
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundDaily" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "tradeDate" DATE NOT NULL,
    "refundCount" INTEGER,
    "refundAmount" DECIMAL(20,2),
    "source" TEXT NOT NULL,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncJob" (
    "id" UUID NOT NULL,
    "queueName" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestedBy" TEXT,
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "successItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelProvider" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeyCipher" BYTEA,
    "apiKeyIv" BYTEA,
    "apiKeyTag" BYTEA,
    "defaultModel" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastTestedAt" TIMESTAMPTZ(3),
    "lastTestStatus" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ModelProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelProfile" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "providerId" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "temperature" DECIMAL(4,3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ModelProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelAccount" (
    "id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "displayName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ChannelAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelUser" (
    "id" UUID NOT NULL,
    "channelAccountId" UUID NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "pairedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ChannelUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "externalKey" TEXT,
    "title" TEXT,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "model" TEXT,
    "toolName" TEXT,
    "toolRunId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolRun" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "messageId" UUID,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "params" JSONB,
    "resultMeta" JSONB,
    "dataAsOf" TIMESTAMPTZ(3),
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledReport" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "shopIds" TEXT[],
    "channels" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ScheduledReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSnapshot" (
    "id" UUID NOT NULL,
    "scheduledReportId" UUID,
    "type" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL,
    "dataAsOf" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "channel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT,
    "result" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "durationMs" INTEGER,
    "params" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");

-- CreateIndex
CREATE INDEX "UserSession_userId_expiresAt_idx" ON "UserSession"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Role_code_key" ON "Role"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ErpCredential_singletonKey_key" ON "ErpCredential"("singletonKey");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_fuduoShopId_key" ON "Shop"("fuduoShopId");

-- CreateIndex
CREATE INDEX "Shop_status_lastVisibleAt_idx" ON "Shop"("status", "lastVisibleAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopAccount_externalAccountId_key" ON "ShopAccount"("externalAccountId");

-- CreateIndex
CREATE INDEX "SalesDaily_tradeDate_idx" ON "SalesDaily"("tradeDate");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDaily_shopId_tradeDate_key" ON "SalesDaily"("shopId", "tradeDate");

-- CreateIndex
CREATE INDEX "SalesSnapshot_shopId_tradeDate_capturedAt_idx" ON "SalesSnapshot"("shopId", "tradeDate", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderDaily_shopId_tradeDate_key" ON "OrderDaily"("shopId", "tradeDate");

-- CreateIndex
CREATE UNIQUE INDEX "RefundDaily_shopId_tradeDate_key" ON "RefundDaily"("shopId", "tradeDate");

-- CreateIndex
CREATE UNIQUE INDEX "SyncJob_idempotencyKey_key" ON "SyncJob"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ModelProfile_key_key" ON "ModelProfile"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelAccount_channel_externalId_key" ON "ChannelAccount"("channel", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelUser_channelAccountId_externalUserId_key" ON "ChannelUser"("channelAccountId", "externalUserId");

-- CreateIndex
CREATE INDEX "ToolRun_createdAt_idx" ON "ToolRun"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReportSnapshot_scheduledReportId_periodStart_periodEnd_vers_key" ON "ReportSnapshot"("scheduledReportId", "periodStart", "periodEnd", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_traceId_key" ON "AuditLog"("traceId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopAccount" ADD CONSTRAINT "ShopAccount_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDaily" ADD CONSTRAINT "SalesDaily_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesSnapshot" ADD CONSTRAINT "SalesSnapshot_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderDaily" ADD CONSTRAINT "OrderDaily_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundDaily" ADD CONSTRAINT "RefundDaily_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelProfile" ADD CONSTRAINT "ModelProfile_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ModelProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelUser" ADD CONSTRAINT "ChannelUser_channelAccountId_fkey" FOREIGN KEY ("channelAccountId") REFERENCES "ChannelAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelUser" ADD CONSTRAINT "ChannelUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolRun" ADD CONSTRAINT "ToolRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolRun" ADD CONSTRAINT "ToolRun_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSnapshot" ADD CONSTRAINT "ReportSnapshot_scheduledReportId_fkey" FOREIGN KEY ("scheduledReportId") REFERENCES "ScheduledReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
