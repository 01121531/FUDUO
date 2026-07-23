DROP INDEX "AuditLog_traceId_key";

CREATE INDEX "AuditLog_traceId_idx" ON "AuditLog"("traceId");
