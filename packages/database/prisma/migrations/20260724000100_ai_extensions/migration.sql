CREATE TABLE "AiExtension" (
  "id" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "manifest" JSONB NOT NULL,
  "files" JSONB NOT NULL,
  "validation" JSONB NOT NULL,
  "installedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiExtension_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiExtension_slug_version_key" ON "AiExtension"("slug", "version");
CREATE INDEX "AiExtension_ownerId_createdAt_idx" ON "AiExtension"("ownerId", "createdAt");
CREATE INDEX "AiExtension_status_updatedAt_idx" ON "AiExtension"("status", "updatedAt");

ALTER TABLE "AiExtension"
  ADD CONSTRAINT "AiExtension_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
