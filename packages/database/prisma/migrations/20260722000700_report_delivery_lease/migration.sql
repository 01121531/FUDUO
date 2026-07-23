ALTER TABLE "ReportDelivery"
  ADD COLUMN "leaseToken" UUID,
  ADD COLUMN "leaseExpiresAt" TIMESTAMPTZ(3);

CREATE INDEX "ReportDelivery_status_leaseExpiresAt_idx"
  ON "ReportDelivery"("status", "leaseExpiresAt");
