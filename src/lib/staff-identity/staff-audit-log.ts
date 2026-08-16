import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";

// Business rules 80-84: immutable minimal staff audit trail. No update/
// delete call site exists anywhere in this domain — append-only by
// convention (Postgres mirror additionally forces RLS with no
// update/delete grants).
export function recordStaffAuditEvent(input: {
  actorStaffAccountId: string | null;
  targetStaffAccountId?: string | null;
  canonicalAction: string;
  resourceType?: string;
  resourceSafeId?: string;
  reason?: string | null;
  result: "success" | "denied" | "failure";
  requestId?: string;
  policyVersion?: number;
  roleVersion?: number;
  now?: Date;
}) {
  getDb()
    .prepare(
      `insert into staff_audit_log
       (id,actor_staff_account_id,target_staff_account_id,canonical_action,resource_type,resource_safe_id,
        reason,result,request_id,policy_version,role_version,created_at)
       values (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      randomUUID(),
      input.actorStaffAccountId,
      input.targetStaffAccountId ?? null,
      input.canonicalAction,
      input.resourceType ?? null,
      input.resourceSafeId ?? null,
      input.reason ?? null,
      input.result,
      input.requestId ?? null,
      input.policyVersion ?? null,
      input.roleVersion ?? null,
      (input.now ?? new Date()).toISOString(),
    );
}

export function listStaffAuditLog(input: { staffAccountId?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const db = getDb();
  if (input.staffAccountId) {
    return db
      .prepare(
        `select * from staff_audit_log where actor_staff_account_id=? or target_staff_account_id=?
         order by created_at desc limit ?`,
      )
      .all(input.staffAccountId, input.staffAccountId, limit);
  }
  return db.prepare("select * from staff_audit_log order by created_at desc limit ?").all(limit);
}
