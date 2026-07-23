import { SetMetadata } from "@nestjs/common";

export const AUDIT_POLICY = Symbol("audit-policy");

export interface AuditPolicy {
  action: string;
  resource?: string;
  resourceParam?: string;
}

export function AuditAction(policy: AuditPolicy) {
  if (!policy.action.trim() || policy.action.length > 100) throw new Error("AUDIT_ACTION_INVALID");
  if (policy.resource && policy.resource.length > 200) throw new Error("AUDIT_RESOURCE_INVALID");
  if (policy.resourceParam && !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(policy.resourceParam)) throw new Error("AUDIT_RESOURCE_PARAM_INVALID");
  return SetMetadata(AUDIT_POLICY, Object.freeze({ ...policy, action: policy.action.trim() }));
}
