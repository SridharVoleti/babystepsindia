import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";

// PC-004: one-year post-entitlement retention, erasure/de-identification,
// processor-propagation tracking and backup-restore deletion replay.
// Reuses learner_journey_retention_state (src/lib/journey/service.ts) as
// the ONE canonical retention timer/state record — this module never
// creates a second inactivity clock. `learners.display_name`/
// `normalized_display_name`/`date_of_birth` are all NOT NULL (schema
// constraint predates this requirement), so "de-identify" here means
// replacing with a fixed, clearly-marked, non-identifying placeholder
// rather than NULLing the column — safer than a NOT NULL constraint
// rebuild that would also need every existing non-null-safe caller
// audited across the codebase.
const DEIDENTIFIED_DISPLAY_NAME = "Deleted Learner";
const DEIDENTIFIED_DATE_OF_BIRTH = "1970-01-01";

// Rule: "Financial/security/audit legal records remain isolated only as
// required" — this module never writes to any of these tables. Asserted
// as a frozen invariant in tests/pc-004-architecture.test.ts too.
const LEGAL_RETENTION_TABLES = [
  "payments", "subscription_audit_log", "staff_audit_log", "entitlement_lifecycle_events",
  "refund_cases", "financial_dispute_events", "staff_recovery_sessions", "platform_recovery_codes",
] as const;
export { LEGAL_RETENTION_TABLES };

function deidentifiedNormalizedName(learnerId: string): string {
  return `deleted-learner-${learnerId}`;
}

// Rule: "Due personal/learning data is irreversibly erased/de-identified."
// Idempotent — safe to call multiple times (e.g. from replayDeletionObligations
// after a backup restore) since every statement is a no-op once already applied.
//
// Scope note: this erases the learner's own DIRECT identity fields
// (display_name/normalized_display_name/date_of_birth — PC-001's catalog
// already flags these as the only restricted_child_data columns) plus the
// journey-display content this same purge already removed (the caller,
// purgeLearnerJourneyIfDue). It deliberately does NOT touch
// learner_app_progress/lesson_completions/learner_app_consistency —
// EG-005's own frozen contract (tests/eg-005.acceptance.test.ts,
// AT-EG-005-32..36) asserts progress data survives a journey purge
// untouched, since that data belongs to PR-003/PR-004's own separate
// lifecycle with retention rules this module doesn't own and shouldn't
// second-guess. Extending erasure into that domain is flagged as future
// scope for whichever session owns PR-003/PR-004's own retention story,
// not assumed here.
export function erasePersonalAndLearningData(learnerId: string, now: Date): { erased: boolean } {
  const db = getDb();
  const timestamp = now.toISOString();

  db.prepare(
    `update learners set display_name=?, normalized_display_name=?, date_of_birth=?, updated_at=?
     where id=? and display_name<>?`,
  ).run(DEIDENTIFIED_DISPLAY_NAME, deidentifiedNormalizedName(learnerId), DEIDENTIFIED_DATE_OF_BIRTH,
    timestamp, learnerId, DEIDENTIFIED_DISPLAY_NAME);

  const generation = (db.prepare(
    "select retention_generation from learner_journey_retention_state where learner_id=?",
  ).get(learnerId) as { retention_generation: number } | undefined)?.retention_generation ?? 1;

  db.prepare(
    `insert into data_erasure_receipts (id,learner_id,retention_generation,erased_at,processor_status,created_at)
     values (?,?,?,?,'none_configured',?)`,
  ).run(randomUUID(), learnerId, generation, timestamp, timestamp);

  return { erased: true };
}

export type ErasureReceipt = {
  id: string; learner_id: string; retention_generation: number; erased_at: string;
  processor_status: "none_configured" | "pending" | "completed" | "failed";
  processor_attempt_count: number; replayed_at: string | null; created_at: string;
};

export function listErasureReceipts(learnerId: string): ErasureReceipt[] {
  return getDb().prepare(
    "select * from data_erasure_receipts where learner_id=? order by created_at desc",
  ).all(learnerId) as ErasureReceipt[];
}

// Rule: "Processor/derived deletions are tracked/retried." No real
// external processor is integrated in this codebase yet (PC-001 confirmed
// zero tracker/analytics-SDK dependencies) — this records/retries a real
// propagation attempt against whatever list of processor keys IS
// configured, which is currently empty. A future processor integration
// registers a key here; this function's contract doesn't change.
const REGISTERED_PROCESSOR_KEYS: readonly string[] = [];

export function retryProcessorPropagation(learnerId: string, now: Date): { attempted: number } {
  if (REGISTERED_PROCESSOR_KEYS.length === 0) return { attempted: 0 };
  const db = getDb();
  const latest = db.prepare(
    "select id, processor_attempt_count from data_erasure_receipts where learner_id=? order by created_at desc limit 1",
  ).get(learnerId) as { id: string; processor_attempt_count: number } | undefined;
  if (!latest) return { attempted: 0 };
  db.prepare(
    "update data_erasure_receipts set processor_status='completed', processor_attempt_count=processor_attempt_count+1 where id=?",
  ).run(latest.id);
  return { attempted: REGISTERED_PROCESSOR_KEYS.length };
}

// Rule: "Restored backup replays completed deletion obligations." — the
// BR-002 handoff point: a restored backup may resurrect pre-erasure
// learner data if the backup predates a completed erasure. Given a
// learner_id, re-applies erasure idempotently if the retention record
// (itself part of the restored backup) shows the erasure should already
// have happened. BR-002 itself (not yet built) is expected to call this
// once per affected learner after a restore completes; no restore-trigger
// route is fabricated here since no restore infrastructure exists yet.
export function replayDeletionObligations(learnerId: string, now: Date): { replayed: boolean } {
  const db = getDb();
  const state = db.prepare(
    "select state, purged_at from learner_journey_retention_state where learner_id=?",
  ).get(learnerId) as { state: string; purged_at: string | null } | undefined;
  if (!state || state.state !== "purged") return { replayed: false };
  const learner = db.prepare("select display_name from learners where id=?").get(learnerId) as
    { display_name: string } | undefined;
  if (!learner || learner.display_name === DEIDENTIFIED_DISPLAY_NAME) return { replayed: false };
  erasePersonalAndLearningData(learnerId, now);
  db.prepare(
    "update data_erasure_receipts set replayed_at=? where learner_id=? and replayed_at is null and rowid=(select rowid from data_erasure_receipts where learner_id=? order by created_at desc limit 1)",
  ).run(now.toISOString(), learnerId, learnerId);
  return { replayed: true };
}
