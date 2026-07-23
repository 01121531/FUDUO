CREATE TABLE "ReportDelivery" (
    "id" UUID NOT NULL,
    "reportSnapshotId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "externalMessageId" TEXT,
    "errorCode" TEXT,
    "lastAttemptAt" TIMESTAMPTZ(3),
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReportDelivery_reportSnapshotId_channel_recipient_key"
ON "ReportDelivery"("reportSnapshotId", "channel", "recipient");

CREATE INDEX "ReportDelivery_status_createdAt_idx"
ON "ReportDelivery"("status", "createdAt");

ALTER TABLE "ReportDelivery"
ADD CONSTRAINT "ReportDelivery_reportSnapshotId_fkey"
FOREIGN KEY ("reportSnapshotId") REFERENCES "ReportSnapshot"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
