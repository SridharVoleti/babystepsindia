import { resolveDbClient } from "@/lib/db-client";
import { PlatformGovernanceError } from "@/lib/platform-governance/contracts";

// Rule 112: default max interactive window when no staff/action/resource
// filter narrows the query.
const DEFAULT_MAX_WINDOW_MS = 90 * 24 * 60 * 60_000;

export type AuditFilters = {
  from: string;
  to: string;
  staffAccountId?: string;
  roleKey?: string;
  canonicalAction?: string;
  result?: string;
  caseId?: string;
  operationChangeId?: string;
  resourceType?: string;
  resourceRef?: string;
  cursor?: string;
  limit?: number;
};

export type AuditEvent = {
  id: string;
  source: "staff" | "support_case" | "operation_change";
  actorStaffAccountId: string | null;
  canonicalAction: string;
  underlyingRole: string | null;
  resourceType: string | null;
  resourceSafeId: string | null;
  caseId: string | null;
  operationChangeId: string | null;
  result: string;
  createdAt: string;
};

// Rules 79-91: read-only, bounded, allowlisted-filter view composed live
// over the three existing append-only activity tables (AD-001's
// staff_audit_log, AD-002's support_case_activity, AD-004's
// platform_operation_activity) — no duplicate audit table, no free-form
// SQL/filter expression accepted from the caller.
export async function queryPrivilegedAudit(filters: AuditFilters): Promise<{ events: AuditEvent[]; nextCursor: string | null }> {
  const fromDate = new Date(filters.from);
  const toDate = new Date(filters.to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate > toDate) {
    throw new PlatformGovernanceError("INVALID_REQUEST");
  }
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);

  // Rule 112: only a staff/action/resource-narrowed query may reach further
  // back than 90 days — an unnarrowed query is silently clamped, never
  // rejected, matching how every other bounded read in this codebase
  // degrades rather than errors on an over-wide request.
  const narrowed = Boolean(
    filters.staffAccountId || filters.canonicalAction || filters.caseId || filters.operationChangeId || filters.resourceRef,
  );
  let effectiveFrom = fromDate;
  if (!narrowed && toDate.getTime() - fromDate.getTime() > DEFAULT_MAX_WINDOW_MS) {
    effectiveFrom = new Date(toDate.getTime() - DEFAULT_MAX_WINDOW_MS);
  }

  const clauses: string[] = ["created_at>=?", "created_at<=?"];
  const params: unknown[] = [effectiveFrom.toISOString(), toDate.toISOString()];
  if (filters.staffAccountId) { clauses.push("actor_staff_account_id=?"); params.push(filters.staffAccountId); }
  if (filters.roleKey) { clauses.push("underlying_role=?"); params.push(filters.roleKey); }
  if (filters.canonicalAction) { clauses.push("canonical_action=?"); params.push(filters.canonicalAction); }
  if (filters.result) { clauses.push("result=?"); params.push(filters.result); }
  if (filters.caseId) { clauses.push("case_id=?"); params.push(filters.caseId); }
  if (filters.operationChangeId) { clauses.push("operation_change_id=?"); params.push(filters.operationChangeId); }
  if (filters.resourceType) { clauses.push("resource_type=?"); params.push(filters.resourceType); }
  if (filters.resourceRef) { clauses.push("resource_safe_id=?"); params.push(filters.resourceRef); }
  if (filters.cursor) { clauses.push("(created_at,id)<(select created_at,id from unioned_audit where id=?)"); params.push(filters.cursor); }
  params.push(limit + 1);

  const rows = await resolveDbClient().all<{
    id: string; source: AuditEvent["source"]; actor_staff_account_id: string | null; canonical_action: string;
    underlying_role: string | null; resource_type: string | null; resource_safe_id: string | null;
    case_id: string | null; operation_change_id: string | null; result: string; created_at: string;
  }>(
    `with unioned_audit as (
       select id, 'staff' as source, actor_staff_account_id, canonical_action, null as underlying_role,
         resource_type, resource_safe_id, null as case_id, null as operation_change_id, result, created_at
       from staff_audit_log
       union all
       select id, 'support_case' as source, actor_staff_account_id, canonical_action, underlying_role,
         'support_case' as resource_type, resource_safe_id, case_id, null as operation_change_id, result, created_at
       from support_case_activity
       union all
       select id, 'operation_change' as source, staff_account_id as actor_staff_account_id, canonical_action, underlying_role,
         'operation_change' as resource_type, resource_safe_id, null as case_id, operation_change_id, result, created_at
       from platform_operation_activity
     )
     select * from unioned_audit where ${clauses.join(" and ")} order by created_at desc, id desc limit ?`,
    params as (string | number)[],
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    events: page.map((row) => ({
      id: row.id, source: row.source, actorStaffAccountId: row.actor_staff_account_id,
      canonicalAction: row.canonical_action, underlyingRole: row.underlying_role, resourceType: row.resource_type,
      resourceSafeId: row.resource_safe_id, caseId: row.case_id, operationChangeId: row.operation_change_id,
      result: row.result, createdAt: row.created_at,
    })),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}
