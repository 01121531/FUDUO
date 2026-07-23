ALTER TABLE "ReportSnapshot"
ADD COLUMN "createdByUserId" UUID,
ADD COLUMN "shopIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "ReportSnapshot"
ADD CONSTRAINT "ReportSnapshot_createdByUserId_fkey"
FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ReportSnapshot_createdByUserId_createdAt_idx"
ON "ReportSnapshot"("createdByUserId", "createdAt");
