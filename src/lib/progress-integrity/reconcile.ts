import { resolveDbClient } from "@/lib/db-client";
import { validateProgressIntegrity, type IntegrityClassification } from "@/lib/progress-integrity/service";

type ProgressPageRow = { learner_id: string; app_id: string; updated_at: string };

export type ReconciliationSweepInput = {
  appId?: string; environment: string; cursor?: string; limit: number; runIdempotencyKey: string; now: Date;
};

export type ReconciliationSweepResult = {
  processed: number; nextCursor: string | null; incidentsOpened: number; repairsApplied: number;
};

function encodeCursor(row: ProgressPageRow): string {
  return `${row.updated_at}|${row.learner_id}|${row.app_id}`;
}

function decodeCursor(cursor: string | undefined): { updatedAt: string; learnerId: string; appId: string } {
  if (!cursor) return { updatedAt: "", learnerId: "", appId: "" };
  const [updatedAt = "", learnerId = "", appId = ""] = cursor.split("|");
  return { updatedAt, learnerId, appId };
}

type SweepRunRow = { processed: number; next_cursor: string | null; incidents_opened: number; repairs_applied: number };

// PR-004 rules 56-59: bounded, paginated, idempotent, environment-isolated
// scheduled reconciliation. Mirrors sweepReleaseSafetyObservations's
// restart-safe design (src/lib/deployment-rollback/service.ts) — all
// progress lives in the row/page cache, nothing in process memory, so a
// missed or interrupted run just resumes from the last committed cursor.
// "Repair" is not a separate code path: retry_safe_metadata_repair's own
// fix (Section incidents.ts) is exactly a fresh re-evaluation, which is
// what every row in the page already gets here — a blocked_repairable_
// metadata row whose underlying data has since self-corrected (e.g. a
// later checkpoint wrote a current summary) simply comes back healthy.
export async function runReconciliationSweep(input: ReconciliationSweepInput): Promise<ReconciliationSweepResult> {
  const db = resolveDbClient();
  const bounded = Math.max(1, Math.min(500, input.limit));
  const cursorKey = input.cursor ?? "";

  const cached = await db.get<SweepRunRow>(`select * from progress_integrity_sweep_runs
    where run_idempotency_key=? and cursor=?`, [input.runIdempotencyKey, cursorKey]);
  if (cached) {
    return { processed: cached.processed, nextCursor: cached.next_cursor, incidentsOpened: cached.incidents_opened,
      repairsApplied: cached.repairs_applied };
  }

  const { updatedAt, learnerId, appId } = decodeCursor(input.cursor);
  const appFilter = input.appId ? "and app_id=?" : "";
  const params: Array<string | number> = input.appId
    ? [updatedAt, updatedAt, learnerId, updatedAt, learnerId, appId, input.appId, bounded + 1]
    : [updatedAt, updatedAt, learnerId, updatedAt, learnerId, appId, bounded + 1];
  const rows = await db.all<ProgressPageRow>(`select learner_id, app_id, updated_at from learner_app_progress
    where (updated_at > ? or (updated_at = ? and learner_id > ?) or (updated_at = ? and learner_id = ? and app_id > ?))
    ${appFilter} order by updated_at, learner_id, app_id limit ?`, params);

  const page = rows.slice(0, bounded);
  const nextCursor = rows.length > bounded ? encodeCursor(page[page.length - 1]) : null;

  let incidentsOpened = 0;
  let repairsApplied = 0;
  const priorClassifications = new Map<string, IntegrityClassification>();
  for (const row of page) {
    const key = `${row.learner_id}:${row.app_id}`;
    const priorRow = await db.get<{ integrity_state: IntegrityClassification }>(
      `select integrity_state from learner_app_progress_integrity where learner_id=? and app_id=?`,
      [row.learner_id, row.app_id]);
    priorClassifications.set(key, priorRow?.integrity_state ?? "healthy");
  }

  for (const row of page) {
    const key = `${row.learner_id}:${row.app_id}`;
    const before = priorClassifications.get(key)!;
    const result = await validateProgressIntegrity({ learnerId: row.learner_id, appId: row.app_id, environment: input.environment,
      reason: "reconcile", requesterPrincipalId: "progress-integrity-sweep", now: input.now });
    if (result.incidentId && before !== result.classification) incidentsOpened += 1;
    if (before === "blocked_repairable_metadata" && (result.classification === "healthy" || result.classification === "read_only_safe")) {
      repairsApplied += 1;
    }
  }

  await db.run(`insert into progress_integrity_sweep_runs(run_idempotency_key,cursor,environment,app_id,processed,
    next_cursor,incidents_opened,repairs_applied,created_at) values(?,?,?,?,?,?,?,?,?)`,
    [input.runIdempotencyKey, cursorKey, input.environment, input.appId ?? null, page.length, nextCursor,
      incidentsOpened, repairsApplied, input.now.toISOString()]);

  return { processed: page.length, nextCursor, incidentsOpened, repairsApplied };
}
