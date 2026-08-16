import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { findUserByEmail, findUserById } from "@/lib/db/users";
import { maskEmail } from "@/lib/account/mask";
import { findStaffById } from "@/lib/staff-identity/accounts-repo";
import { roleHasCapability } from "@/lib/staff-identity/roles";
import {
  SupportCaseError, isValidReason, isValidNoteText, containsForbiddenNoteContent,
  type ResolveCustomerInput, type ResolveCustomerResult, type CreateSupportCaseInput,
  type SupportCaseListFilters, type SupportCaseSummary, type SupportCaseNote,
  type UpdateSupportCaseWorkflowInput, type AddSupportCaseNoteInput, type ReopenSupportCaseInput,
  type EscalationRole, type SupportCaseStatus,
} from "./contracts";

// Rule 21/26: a short-lived window between resolving a customer and binding
// a case to them — long enough for a staff member to read the minimal
// result and decide, short enough that a stale receipt can't be replayed
// long after the lookup context is gone.
const LOOKUP_RECEIPT_TTL_MS = 15 * 60_000;
// Rule 98: closed-case content retention.
const CASE_RETENTION_MONTHS = 24;

function hashIdentifier(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

type StaffCaller = { staffAccountId: string; roleKeys: readonly string[] };

function logActivity(caseId: string, actor: StaffCaller, canonicalAction: string, underlyingRole: string | null,
  resourceSafeId: string | null, result: string, now: Date) {
  getDb().prepare(
    `insert into support_case_activity(id,case_id,actor_staff_account_id,canonical_action,underlying_role,
     resource_safe_id,result,request_id,created_at) values(?,?,?,?,?,?,?,?,?)`,
  ).run(randomUUID(), caseId, actor.staffAccountId, canonicalAction, underlyingRole, resourceSafeId, result,
    randomUUID(), now.toISOString());
}

// Rules 17-26: exact-match-only customer resolver. Never fuzzy, never a
// name/browse lookup, never near-match suggestions. POST-only (enforced by
// the route, never a GET with the identifier in a query string — rule 20).
export function resolveCustomer(actor: StaffCaller, input: ResolveCustomerInput, now: Date = new Date()): ResolveCustomerResult {
  if (!isValidReason(input.reason)) throw new SupportCaseError("INVALID_REASON");
  const db = getDb();
  const receiptId = randomUUID();
  const timestamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + LOOKUP_RECEIPT_TTL_MS).toISOString();
  const identifierHash = hashIdentifier(input.identifierValue);

  const insertReceipt = (resultClass: "matched" | "no_match" | "duplicate_match", resolved: {
    parentId?: string; learnerId?: string; appId?: string; subscriptionId?: string; invoiceId?: string;
  } = {}) => {
    db.prepare(
      `insert into support_lookup_receipts(id,staff_account_id,identifier_type,identifier_hash,result_class,
       resolved_parent_id,resolved_learner_id,resolved_app_id,resolved_subscription_id,resolved_invoice_id,
       reason,created_at,expires_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(receiptId, actor.staffAccountId, input.identifierType, identifierHash, resultClass,
      resolved.parentId ?? null, resolved.learnerId ?? null, resolved.appId ?? null,
      resolved.subscriptionId ?? null, resolved.invoiceId ?? null, input.reason, timestamp, expiresAt);
  };

  if (input.identifierType === "email") {
    // Rule 18: normalized CURRENT VERIFIED parent email only.
    const user = findUserByEmail(input.identifierValue);
    if (!user || !user.email_verified_at) { insertReceipt("no_match"); return { receiptId, matched: false }; }
    const profile = db.prepare("select display_name, account_status from profiles where id=?").get(user.id) as
      { display_name: string | null; account_status: string } | undefined;
    insertReceipt("matched", { parentId: user.id });
    return {
      receiptId, matched: true, displayName: profile?.display_name ?? undefined,
      maskedEmail: maskEmail(user.email), accountStatus: profile?.account_status,
    };
  }

  if (input.identifierType === "subscription_ref") {
    const row = db.prepare("select id, purchaser_parent_id, assigned_learner_id from subscriptions where id=?")
      .get(input.identifierValue) as { id: string; purchaser_parent_id: string; assigned_learner_id: string } | undefined;
    if (!row) { insertReceipt("no_match"); return { receiptId, matched: false }; }
    const user = findUserById(row.purchaser_parent_id);
    const profile = db.prepare("select display_name, account_status from profiles where id=?")
      .get(row.purchaser_parent_id) as { display_name: string | null; account_status: string } | undefined;
    insertReceipt("matched", { parentId: row.purchaser_parent_id, learnerId: row.assigned_learner_id, subscriptionId: row.id });
    return {
      receiptId, matched: true, displayName: profile?.display_name ?? undefined,
      maskedEmail: maskEmail(user?.email), accountStatus: profile?.account_status,
    };
  }

  if (input.identifierType === "invoice_ref") {
    const row = db.prepare(
      `select p.id, s.purchaser_parent_id, s.id as subscription_id from payments p
       join subscriptions s on s.id=p.subscription_id where p.id=? or p.razorpay_payment_id=?`,
    ).get(input.identifierValue, input.identifierValue) as
      { id: string; purchaser_parent_id: string; subscription_id: string } | undefined;
    if (!row) { insertReceipt("no_match"); return { receiptId, matched: false }; }
    const user = findUserById(row.purchaser_parent_id);
    const profile = db.prepare("select display_name, account_status from profiles where id=?")
      .get(row.purchaser_parent_id) as { display_name: string | null; account_status: string } | undefined;
    insertReceipt("matched", { parentId: row.purchaser_parent_id, subscriptionId: row.subscription_id, invoiceId: row.id });
    return {
      receiptId, matched: true, displayName: profile?.display_name ?? undefined,
      maskedEmail: maskEmail(user?.email), accountStatus: profile?.account_status,
    };
  }

  // identifierType === "case_id": resolves to the SAME case's owning
  // parent, for continuity — never a new browse surface.
  const existingCase = db.prepare("select parent_id from support_cases where id=?")
    .get(input.identifierValue) as { parent_id: string } | undefined;
  if (!existingCase) { insertReceipt("no_match"); return { receiptId, matched: false }; }
  const user = findUserById(existingCase.parent_id);
  const profile = db.prepare("select display_name, account_status from profiles where id=?")
    .get(existingCase.parent_id) as { display_name: string | null; account_status: string } | undefined;
  insertReceipt("matched", { parentId: existingCase.parent_id });
  return {
    receiptId, matched: true, displayName: profile?.display_name ?? undefined,
    maskedEmail: maskEmail(user?.email), accountStatus: profile?.account_status,
  };
}

type ReceiptRow = {
  id: string; staff_account_id: string; result_class: string; resolved_parent_id: string | null;
  resolved_learner_id: string | null; resolved_app_id: string | null; resolved_subscription_id: string | null;
  resolved_invoice_id: string | null; consumed_at: string | null; expires_at: string;
};

// Rules 9, 12, 27-28: a case can only be created from a valid, unexpired,
// unconsumed, matched receipt belonging to the calling staff member — never
// a freeform parentId the caller could type in directly.
export function createSupportCase(actor: StaffCaller, input: CreateSupportCaseInput, now: Date = new Date()): SupportCaseSummary {
  const db = getDb();
  return db.transaction(() => {
    const existing = db.prepare("select id from support_cases where created_from_receipt_id=?")
      .get(input.receiptId) as { id: string } | undefined;
    if (existing) return getCaseSummary(existing.id)!;

    const receipt = db.prepare("select * from support_lookup_receipts where id=? and staff_account_id=?")
      .get(input.receiptId, actor.staffAccountId) as ReceiptRow | undefined;
    if (!receipt) throw new SupportCaseError("RECEIPT_NOT_FOUND");
    if (receipt.result_class !== "matched" || !receipt.resolved_parent_id) throw new SupportCaseError("RECEIPT_NOT_MATCHED");
    if (new Date(receipt.expires_at).getTime() < now.getTime()) throw new SupportCaseError("RECEIPT_EXPIRED");
    if (!isValidReason(input.reason)) throw new SupportCaseError("INVALID_REASON");

    const caseId = randomUUID();
    const timestamp = now.toISOString();
    db.prepare(
      `insert into support_cases(id,category,status,priority,parent_id,learner_id,app_id,subscription_id,
       invoice_id,created_from_receipt_id,version,reopened_count,created_by_staff_account_id,created_at,updated_at)
       values(?,?,'open','normal',?,?,?,?,?,?,1,0,?,?,?)`,
    ).run(caseId, input.category, receipt.resolved_parent_id, receipt.resolved_learner_id, receipt.resolved_app_id,
      receipt.resolved_subscription_id, receipt.resolved_invoice_id, input.receiptId, actor.staffAccountId, timestamp, timestamp);
    db.prepare("update support_lookup_receipts set consumed_at=? where id=?").run(timestamp, input.receiptId);
    logActivity(caseId, actor, "admin.support.case.create", "support_agent", caseId, "success", now);
    return getCaseSummary(caseId)!;
  })();
}

function getCaseSummary(caseId: string): SupportCaseSummary | null {
  const row = getDb().prepare(
    "select id,category,status,priority,assigned_staff_account_id,created_at,updated_at from support_cases where id=?",
  ).get(caseId) as {
    id: string; category: SupportCaseSummary["category"]; status: SupportCaseSummary["status"];
    priority: SupportCaseSummary["priority"]; assigned_staff_account_id: string | null;
    created_at: string; updated_at: string;
  } | undefined;
  if (!row) return null;
  return {
    caseId: row.id, category: row.category, status: row.status, priority: row.priority,
    assignedStaffAccountId: row.assigned_staff_account_id, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

// Rules 32-33, 79-80: scoped by role/assignment/status BEFORE pagination —
// a support-only staff member never even counts cases assigned to a
// billing/operations escalation they don't hold, and filters never include
// a performance/profiling dimension.
export function listSupportCases(actor: StaffCaller, filters: SupportCaseListFilters): { cases: SupportCaseSummary[]; nextCursor: string | null } {
  const limit = Math.min(filters.limit ?? 20, 50);
  const params: unknown[] = [];
  const clauses: string[] = [];

  // A case is visible to this staff member if: assigned to them, unassigned
  // AND not escalated (an escalated-but-unassigned case is a queue for the
  // target role family only, never a general-support catch-all), or
  // escalated to a role family they explicitly hold.
  const visibleEscalationRoles = (["billing_administrator", "operations_administrator", "platform_administrator"] as const)
    .filter((role) => actor.roleKeys.includes(role));
  const escalationPlaceholders = visibleEscalationRoles.map(() => "?").join(",");
  clauses.push(`(assigned_staff_account_id=?` +
    ` or (assigned_staff_account_id is null and status<>'escalated')` +
    (visibleEscalationRoles.length ? ` or (status='escalated' and escalation_role in (${escalationPlaceholders}))` : "") + ")");
  params.push(actor.staffAccountId, ...visibleEscalationRoles);

  if (filters.status) { clauses.push("status=?"); params.push(filters.status); }
  if (filters.category) { clauses.push("category=?"); params.push(filters.category); }
  if (filters.assignedToMe) { clauses.push("assigned_staff_account_id=?"); params.push(actor.staffAccountId); }
  if (filters.cursor) { clauses.push("(created_at<? or (created_at=? and id<?))"); params.push(filters.cursor, filters.cursor, filters.cursor); }

  params.push(limit + 1);
  const rows = getDb().prepare(
    `select id,category,status,priority,assigned_staff_account_id,created_at,updated_at from support_cases
     where ${clauses.join(" and ")} order by created_at desc, id desc limit ?`,
  ).all(...params) as Array<{
    id: string; category: SupportCaseSummary["category"]; status: SupportCaseSummary["status"];
    priority: SupportCaseSummary["priority"]; assigned_staff_account_id: string | null;
    created_at: string; updated_at: string;
  }>;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    cases: page.map((row) => ({
      caseId: row.id, category: row.category, status: row.status, priority: row.priority,
      assignedStaffAccountId: row.assigned_staff_account_id, createdAt: row.created_at, updatedAt: row.updated_at,
    })),
    nextCursor: hasMore ? page[page.length - 1].created_at : null,
  };
}

type FullCaseRow = {
  id: string; category: SupportCaseSummary["category"]; status: SupportCaseStatus; priority: SupportCaseSummary["priority"];
  assigned_staff_account_id: string | null; escalation_role: EscalationRole | null; version: number;
  created_at: string; updated_at: string; closed_at: string | null;
};

// Rules 32, 40, 81, 86: scope check before any read; a foreign/unowned
// case (not visible per the same rule listSupportCases enforces) is a
// safe, non-enumerating deny — never a 404 that leaks "exists but not
// yours" vs "doesn't exist" distinctly.
export function getSupportCase(actor: StaffCaller, caseId: string): FullCaseRow & { visible: boolean } {
  const row = getDb().prepare(
    "select id,category,status,priority,assigned_staff_account_id,escalation_role,version,created_at,updated_at,closed_at from support_cases where id=?",
  ).get(caseId) as FullCaseRow | undefined;
  if (!row) throw new SupportCaseError("CASE_NOT_FOUND");
  const visible = row.assigned_staff_account_id === actor.staffAccountId ||
    (row.assigned_staff_account_id === null && row.status !== "escalated") ||
    (row.status === "escalated" && row.escalation_role !== null && actor.roleKeys.includes(row.escalation_role));
  if (!visible) throw new SupportCaseError("CASE_NOT_FOUND");
  return { ...row, visible };
}

function replayMutation(actor: StaffCaller, caseId: string, idempotencyKey: string, requestHash: string) {
  const existing = getDb().prepare(
    "select request_hash, status, response_json from support_case_mutation_requests where actor_staff_account_id=? and case_id=? and idempotency_key=?",
  ).get(actor.staffAccountId, caseId, idempotencyKey) as
    { request_hash: string; status: string; response_json: string | null } | undefined;
  if (!existing) return null;
  if (existing.request_hash !== requestHash) throw new SupportCaseError("IDEMPOTENCY_KEY_REUSED");
  if (existing.response_json) return JSON.parse(existing.response_json);
  return null;
}

function beginMutation(actor: StaffCaller, caseId: string, idempotencyKey: string, operation: string, requestHash: string, now: Date) {
  getDb().prepare(
    `insert into support_case_mutation_requests(actor_staff_account_id,case_id,idempotency_key,operation,
     request_hash,status,created_at) values(?,?,?,?,?,'processing',?)`,
  ).run(actor.staffAccountId, caseId, idempotencyKey, operation, requestHash, now.toISOString());
}

function completeMutation(actor: StaffCaller, caseId: string, idempotencyKey: string, result: unknown, now: Date) {
  getDb().prepare(
    `update support_case_mutation_requests set status='completed',response_json=?,completed_at=?
     where actor_staff_account_id=? and case_id=? and idempotency_key=?`,
  ).run(JSON.stringify(result), now.toISOString(), actor.staffAccountId, caseId, idempotencyKey);
  return result;
}

const TERMINAL_TRANSITIONS: Record<SupportCaseStatus, SupportCaseStatus[]> = {
  open: ["in_progress", "waiting_parent", "escalated", "resolved", "closed"],
  in_progress: ["waiting_parent", "escalated", "resolved", "closed"],
  waiting_parent: ["in_progress", "escalated", "resolved", "closed"],
  escalated: ["in_progress", "resolved", "closed"],
  resolved: ["closed"],
  closed: [],
};

// Rules 58-68: workflow-only mutation — status/category/assignment/
// escalation/priority. Never mutates any source-domain table (rule 59);
// escalation never grants a role (rule 65); waiting_parent sends no
// automatic email (rule 60, satisfied structurally — this function never
// calls enqueueTransactionalNotification).
export function updateSupportCaseWorkflow(actor: StaffCaller, caseId: string, input: UpdateSupportCaseWorkflowInput, now: Date = new Date()): SupportCaseSummary {
  const db = getDb();
  const requestHash = createHash("sha256").update(JSON.stringify({ ...input, idempotencyKey: undefined })).digest("hex");
  const replay = replayMutation(actor, caseId, input.idempotencyKey, requestHash);
  if (replay) return replay as SupportCaseSummary;

  return db.transaction(() => {
    const current = db.prepare("select status, version from support_cases where id=?").get(caseId) as
      { status: SupportCaseStatus; version: number } | undefined;
    if (!current) throw new SupportCaseError("CASE_NOT_FOUND");
    if (current.version !== input.expectedVersion) throw new SupportCaseError("VERSION_CONFLICT");
    beginMutation(actor, caseId, input.idempotencyKey, "workflow_update", requestHash, now);

    if (input.status && input.status !== current.status) {
      if (current.status === "closed") throw new SupportCaseError("CASE_CLOSED");
      if (!TERMINAL_TRANSITIONS[current.status].includes(input.status)) throw new SupportCaseError("INVALID_TRANSITION");
    }
    if (input.escalationRole) {
      // Rule 65: setting the target role never grants it — a real handoff
      // still requires the acting/continuing staff to explicitly hold it
      // for whatever THEY do next; this only records the target.
      if (!["billing_administrator", "operations_administrator", "platform_administrator"].includes(input.escalationRole)) {
        throw new SupportCaseError("INVALID_ESCALATION_ROLE");
      }
    }
    if (input.assignedStaffAccountId) {
      const staff = findStaffById(input.assignedStaffAccountId);
      if (!staff || staff.status !== "active") throw new SupportCaseError("ASSIGNEE_NOT_FOUND");
    }

    const nextStatus = input.status ?? current.status;
    const timestamp = now.toISOString();
    db.prepare(
      `update support_cases set status=?,category=coalesce(?,category),priority=coalesce(?,priority),
       assigned_staff_account_id=coalesce(?,assigned_staff_account_id),
       escalation_role=?,version=version+1,updated_at=?,closed_at=? where id=?`,
    ).run(nextStatus, input.category ?? null, input.priority ?? null,
      input.assignedStaffAccountId ?? null, input.escalationRole ?? null, timestamp,
      nextStatus === "closed" ? timestamp : null, caseId);

    const underlyingRole = input.escalationRole && actor.roleKeys.includes(input.escalationRole)
      ? input.escalationRole : "support_agent";
    logActivity(caseId, actor, input.escalationRole ? "admin.support.case.escalate" : "admin.support.case.workflow_update",
      underlyingRole, caseId, "success", now);

    const result = getCaseSummary(caseId)!;
    return completeMutation(actor, caseId, input.idempotencyKey, result, now) as SupportCaseSummary;
  })();
}

// Rules 53-56: append-only, 1-4000 chars, no password/passkey/payment
// content, attributed to exact staff/time. The unique(case_id,staff,key)
// constraint on the table itself makes a replay idempotent without a
// separate mutation-request table.
export function addSupportCaseNote(actor: StaffCaller, caseId: string, input: AddSupportCaseNoteInput, now: Date = new Date()): SupportCaseNote {
  if (!isValidNoteText(input.noteText)) throw new SupportCaseError("INVALID_NOTE_TEXT");
  if (containsForbiddenNoteContent(input.noteText)) throw new SupportCaseError("NOTE_CONTAINS_FORBIDDEN_CONTENT");
  const db = getDb();
  return db.transaction(() => {
    const existing = db.prepare(
      "select id, note_text, created_at from support_case_notes where case_id=? and staff_account_id=? and idempotency_key=?",
    ).get(caseId, actor.staffAccountId, input.idempotencyKey) as
      { id: string; note_text: string; created_at: string } | undefined;
    if (existing) return { noteId: existing.id, staffAccountId: actor.staffAccountId, noteText: existing.note_text, createdAt: existing.created_at };

    const kase = db.prepare("select status from support_cases where id=?").get(caseId) as { status: SupportCaseStatus } | undefined;
    if (!kase) throw new SupportCaseError("CASE_NOT_FOUND");
    if (kase.status === "closed") throw new SupportCaseError("CASE_CLOSED");

    const noteId = randomUUID();
    const timestamp = now.toISOString();
    db.prepare(
      "insert into support_case_notes(id,case_id,staff_account_id,note_text,idempotency_key,created_at) values(?,?,?,?,?,?)",
    ).run(noteId, caseId, actor.staffAccountId, input.noteText, input.idempotencyKey, timestamp);
    logActivity(caseId, actor, "admin.support.case.note.add", "support_agent", noteId, "success", now);
    return { noteId, staffAccountId: actor.staffAccountId, noteText: input.noteText, createdAt: timestamp };
  })();
}

export function listSupportCaseNotes(caseId: string): SupportCaseNote[] {
  return (getDb().prepare("select id,staff_account_id,note_text,created_at from support_case_notes where case_id=? order by created_at")
    .all(caseId) as Array<{ id: string; staff_account_id: string; note_text: string; created_at: string }>)
    .map((row) => ({ noteId: row.id, staffAccountId: row.staff_account_id, noteText: row.note_text, createdAt: row.created_at }));
}

// Rules 7, 38, 98-99: reopen is only valid on a `resolved` case, within the
// 24-month retention window, with a reason — never on a `closed`-and-
// purged or still-active case.
export function reopenSupportCase(actor: StaffCaller, caseId: string, input: ReopenSupportCaseInput, now: Date = new Date()): SupportCaseSummary {
  if (!isValidReason(input.reason)) throw new SupportCaseError("INVALID_REASON");
  const db = getDb();
  const requestHash = createHash("sha256").update(JSON.stringify({ reason: input.reason })).digest("hex");
  const replay = replayMutation(actor, caseId, input.idempotencyKey, requestHash);
  if (replay) return replay as SupportCaseSummary;

  return db.transaction(() => {
    const current = db.prepare("select status, closed_at, created_at from support_cases where id=?").get(caseId) as
      { status: SupportCaseStatus; closed_at: string | null; created_at: string } | undefined;
    if (!current) throw new SupportCaseError("CASE_NOT_FOUND");
    if (current.status !== "resolved") throw new SupportCaseError("CASE_NOT_REOPENABLE");
    const retentionCutoff = new Date(current.created_at);
    retentionCutoff.setMonth(retentionCutoff.getMonth() + CASE_RETENTION_MONTHS);
    if (now.getTime() > retentionCutoff.getTime()) throw new SupportCaseError("CASE_RETENTION_EXPIRED");

    beginMutation(actor, caseId, input.idempotencyKey, "reopen", requestHash, now);
    const timestamp = now.toISOString();
    db.prepare(
      "update support_cases set status='open',reopened_count=reopened_count+1,version=version+1,updated_at=?,closed_at=null where id=?",
    ).run(timestamp, caseId);
    logActivity(caseId, actor, "admin.support.case.reopen", "support_agent", caseId, "success", now);
    const result = getCaseSummary(caseId)!;
    return completeMutation(actor, caseId, input.idempotencyKey, result, now) as SupportCaseSummary;
  })();
}

// Exposed for tests / escalation-continuation checks: does this staff
// member explicitly hold the given role's capability set (never inferred
// from the Super Admin display label)?
export { roleHasCapability };
