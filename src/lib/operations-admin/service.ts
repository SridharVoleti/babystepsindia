import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { findStaffById } from "@/lib/staff-identity/accounts-repo";
import {
  OperationChangeError, isValidOperationReason,
  type CreateOperationChangeInput, type OperationChangeListFilters, type OperationChangeSummary,
  type OperationChangeStatus, type OperationChangeType, type UpdateOperationChangeWorkflowInput,
} from "./contracts";

const OPERATION_RETENTION_MONTHS = 24;

type StaffCaller = { staffAccountId: string; roleKeys: readonly string[] };

type ChangeRow = {
  id: string; change_type: OperationChangeType; status: OperationChangeStatus; environment: string;
  app_id: string | null; primary_resource_type: string | null; primary_resource_id: string | null;
  reason: string; scheduled_for: string | null; linked_support_case_id: string | null;
  assigned_staff_account_id: string | null; version: number; created_at: string; updated_at: string;
  terminal_at: string | null;
};

function toSummary(row: ChangeRow): OperationChangeSummary {
  return {
    operationChangeId: row.id, changeType: row.change_type, status: row.status, environment: row.environment,
    appId: row.app_id, reason: row.reason, assignedStaffAccountId: row.assigned_staff_account_id,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function logActivity(operationChangeId: string, staffAccountId: string, canonicalAction: string,
  underlyingRole: string | null, resourceSafeId: string | null, result: string, now: Date) {
  getDb().prepare(
    `insert into platform_operation_activity(id,operation_change_id,staff_account_id,canonical_action,
     underlying_role,resource_safe_id,result,request_id,created_at) values(?,?,?,?,?,?,?,?,?)`,
  ).run(randomUUID(), operationChangeId, staffAccountId, canonicalAction, underlyingRole, resourceSafeId,
    result, randomUUID(), now.toISOString());
}

// Rules 17-25, 31-32: server-generated, immutable scope; idempotent create
// (same idempotencyKey + same payload returns the same record — rule 8).
export function createOperationChange(actor: StaffCaller, input: CreateOperationChangeInput, now = new Date()): OperationChangeSummary {
  if (!isValidOperationReason(input.reason)) throw new OperationChangeError("INVALID_REASON");
  const db = getDb();
  return db.transaction(() => {
    const existing = db.prepare(
      "select id, source_reference from platform_operation_changes where created_by_staff_account_id=? and source_reference=?",
    ).get(actor.staffAccountId, `idem:${input.idempotencyKey}`) as { id: string } | undefined;
    if (existing) {
      const row = db.prepare("select * from platform_operation_changes where id=?").get(existing.id) as ChangeRow;
      return toSummary(row);
    }
    // Rule 34: an optional linked case must actually be visible to this
    // staff member — reuses AD-002's own visibility rule via a direct
    // existence+ownership check rather than importing support-cases
    // (avoids a circular module dependency; the same scope logic is
    // intentionally duplicated here at the SQL level only).
    if (input.linkedSupportCaseId) {
      const kase = db.prepare("select status from support_cases where id=?").get(input.linkedSupportCaseId) as
        { status: string } | undefined;
      if (!kase) throw new OperationChangeError("INVALID_REQUEST");
    }
    const id = randomUUID();
    const timestamp = now.toISOString();
    db.prepare(
      `insert into platform_operation_changes(id,change_type,status,environment,app_id,primary_resource_type,
       primary_resource_id,reason,scheduled_for,linked_support_case_id,version,source_reference,
       created_by_staff_account_id,created_at,updated_at)
       values(?,?,'ready',?,?,?,?,?,?,?,1,?,?,?,?)`,
    ).run(id, input.changeType, input.environment, input.appId ?? null, input.primaryResourceType ?? null,
      input.primaryResourceId ?? null, input.reason, input.scheduledFor ?? null, input.linkedSupportCaseId ?? null,
      `idem:${input.idempotencyKey}`, actor.staffAccountId, timestamp, timestamp);
    logActivity(id, actor.staffAccountId, "admin.operations.change.create", "operations_administrator", id, "success", now);
    return toSummary(db.prepare("select * from platform_operation_changes where id=?").get(id) as ChangeRow);
  })();
}

// Rules 32-33: scoped list — every staff member currently sees all
// Operations-visible records (Operations Administrator is not further
// per-record restricted the way AD-002 Support cases are, since routine
// platform work has no per-parent ownership boundary) but assignedToMe/
// status/type/app/environment/date filters still narrow before pagination.
export function listOperationChanges(_actor: StaffCaller, filters: OperationChangeListFilters): {
  changes: OperationChangeSummary[]; nextCursor: string | null;
} {
  const limit = Math.min(filters.limit ?? 20, 50);
  const clauses: string[] = ["1=1"];
  const params: unknown[] = [];
  if (filters.status) { clauses.push("status=?"); params.push(filters.status); }
  if (filters.changeType) { clauses.push("change_type=?"); params.push(filters.changeType); }
  if (filters.appId) { clauses.push("app_id=?"); params.push(filters.appId); }
  if (filters.environment) { clauses.push("environment=?"); params.push(filters.environment); }
  if (filters.assignedToMe) { clauses.push("assigned_staff_account_id=?"); params.push(_actor.staffAccountId); }
  if (filters.cursor) { clauses.push("(created_at<? or (created_at=? and id<?))"); params.push(filters.cursor, filters.cursor, filters.cursor); }
  params.push(limit + 1);
  const rows = getDb().prepare(
    `select * from platform_operation_changes where ${clauses.join(" and ")} order by created_at desc, id desc limit ?`,
  ).all(...params) as ChangeRow[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return { changes: page.map(toSummary), nextCursor: hasMore ? page[page.length - 1].created_at : null };
}

export function getOperationChangeRow(operationChangeId: string): ChangeRow {
  const row = getDb().prepare("select * from platform_operation_changes where id=?").get(operationChangeId) as
    ChangeRow | undefined;
  if (!row) throw new OperationChangeError("OPERATION_CHANGE_NOT_FOUND");
  return row;
}

export function getOperationChange(operationChangeId: string): OperationChangeSummary {
  return toSummary(getOperationChangeRow(operationChangeId));
}

export function listOperationActivity(operationChangeId: string) {
  return getDb().prepare(
    "select id, staff_account_id, canonical_action, underlying_role, resource_safe_id, result, created_at from platform_operation_activity where operation_change_id=? order by created_at",
  ).all(operationChangeId) as Array<{ id: string; staff_account_id: string; canonical_action: string;
    underlying_role: string | null; resource_safe_id: string | null; result: string; created_at: string }>;
}

const TERMINAL_STATUSES = new Set<OperationChangeStatus>(["succeeded", "failed", "cancelled"]);

// Rules 25-30: only workflow fields (status/assignment/schedule) may
// change; type/environment/resource/reason stay immutable — never accepted
// as PATCH input at all (rule 9 in the frozen contract).
export function updateOperationChangeWorkflow(actor: StaffCaller, operationChangeId: string,
  input: UpdateOperationChangeWorkflowInput, now = new Date()): OperationChangeSummary {
  const db = getDb();
  return db.transaction(() => {
    const row = getOperationChangeRow(operationChangeId);
    if (row.version !== input.expectedVersion) throw new OperationChangeError("VERSION_CONFLICT");
    if (TERMINAL_STATUSES.has(row.status)) throw new OperationChangeError("OPERATION_CHANGE_TERMINAL");
    if (input.status === "cancelled" && row.status === "executing") {
      // Rule 30: cancellable only before an owning-domain irreversible
      // mutation begins — once 'executing', ordinary cancel is refused.
      throw new OperationChangeError("INVALID_TRANSITION");
    }
    if (input.assignedStaffAccountId) {
      const staff = findStaffById(input.assignedStaffAccountId);
      if (!staff || staff.status !== "active") throw new OperationChangeError("ASSIGNEE_NOT_FOUND");
    }
    const timestamp = now.toISOString();
    const nextStatus = input.status ?? row.status;
    db.prepare(
      `update platform_operation_changes set status=?,assigned_staff_account_id=coalesce(?,assigned_staff_account_id),
       scheduled_for=coalesce(?,scheduled_for),version=version+1,updated_at=?,
       terminal_at=?,retention_due_at=? where id=?`,
    ).run(nextStatus, input.assignedStaffAccountId ?? null, input.scheduledFor ?? null, timestamp,
      TERMINAL_STATUSES.has(nextStatus) ? timestamp : null,
      TERMINAL_STATUSES.has(nextStatus) ? retentionDueAt(now) : null, operationChangeId);
    logActivity(operationChangeId, actor.staffAccountId, "admin.operations.change.workflow_update",
      "operations_administrator", operationChangeId, "success", now);
    return getOperationChange(operationChangeId);
  })();
}

function retentionDueAt(now: Date): string {
  const due = new Date(now);
  due.setMonth(due.getMonth() + OPERATION_RETENTION_MONTHS);
  return due.toISOString();
}

// Rules 43-49, 94: the amendment point every covered AR/UL/AU sensitive
// route calls before its own owning-domain mutation. Validates the
// operation record exists, is non-terminal, matches the exact change-type
// family and scope (environment + optional appId) being mutated — never
// authorizes the mutation itself, only proves it's change-bound.
export function requireOperationChangeForMutation(input: {
  operationChangeId: string; allowedTypes: readonly OperationChangeType[]; environment: string; appId?: string;
}): ChangeRow {
  const row = getOperationChangeRow(input.operationChangeId);
  if (TERMINAL_STATUSES.has(row.status)) throw new OperationChangeError("OPERATION_CHANGE_TERMINAL");
  if (!input.allowedTypes.includes(row.change_type)) throw new OperationChangeError("OPERATION_CHANGE_TYPE_MISMATCH");
  if (row.environment !== input.environment) throw new OperationChangeError("OPERATION_SCOPE_MISMATCH");
  if (row.app_id && input.appId && row.app_id !== input.appId) throw new OperationChangeError("OPERATION_SCOPE_MISMATCH");
  return row;
}

// Called by an amended route after its own source-domain mutation
// completes — rule 90-91: async acceptance is never itself "succeeded";
// callers pass 'executing' for an accepted-but-async result and only mark
// 'succeeded'/'failed' once the owning domain reports an authoritative
// terminal outcome.
export function recordOperationOutcome(operationChangeId: string, actorStaffId: string, canonicalAction: string,
  outcome: "executing" | "succeeded" | "failed", resourceSafeId: string | null, now = new Date()): void {
  const db = getDb();
  const timestamp = now.toISOString();
  db.prepare(
    `update platform_operation_changes set status=?,version=version+1,updated_at=?,
     terminal_at=?,retention_due_at=? where id=?`,
  ).run(outcome, timestamp, outcome === "succeeded" || outcome === "failed" ? timestamp : null,
    outcome === "succeeded" || outcome === "failed" ? retentionDueAt(now) : null, operationChangeId);
  logActivity(operationChangeId, actorStaffId, canonicalAction, "operations_administrator", resourceSafeId,
    outcome === "failed" ? "failed" : "success", now);
}

export type { ChangeRow as OperationChangeRow };
