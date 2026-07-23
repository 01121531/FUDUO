UPDATE "ScheduledReport" SET "shopIds" = ARRAY[]::TEXT[] WHERE "shopIds" IS NULL;
UPDATE "ScheduledReport" SET "channels" = ARRAY['WEB', 'WECHAT']::TEXT[] WHERE "channels" IS NULL;

ALTER TABLE "ScheduledReport"
ALTER COLUMN "shopIds" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "shopIds" SET NOT NULL,
ALTER COLUMN "channels" SET DEFAULT ARRAY['WEB', 'WECHAT']::TEXT[],
ALTER COLUMN "channels" SET NOT NULL;
