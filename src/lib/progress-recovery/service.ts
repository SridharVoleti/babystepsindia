import { createHash, randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { computeCanonicalStateHash, validateProgressIntegrity } from "@/lib/progress-integrity/service";
import { AppProgressError, validateState, type AppProgressContext } from "@/lib/app-progress/service";
import { ProgressRecoveryError, progressRecoveryErrorStatus } from "@/lib/progress-recovery/errors";

export { ProgressRecoveryError, progressRecoveryErrorStatus };

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown) => JSON.stringify(value);

type SessionRow = {
  id: string; learner_id: string; app_id: string; status: string; device_session_id: string;
  resume_token_hash: string; hard_expires_at: string | null; release_id: string | null;
  deployment_id: string | null; deployment_environment: string | null; parent_user_id: string;
  current_level_key: string | null; current_lesson_key: string | null;
};

async function sessionFor(db: DbClient, context: AppProgressContext): Promise<SessionRow> {
  const row = await db.get<SessionRow>("select * from learner_sessions where id=?", [context.learnerSessionId]);
  if (!row || row.learner_id !== context.learnerId || row.app_id !== context.appId)
    throw new ProgressRecoveryError("SESSION_NOT_RESUMABLE");
  return row;
}

type ReceiptRow = {
  id: string; learner_session_id: string; learner_id: string; app_id: string; result: string;
  request_hash: string; new_progress_version: number | null; new_state_hash: string | null;
};

type ProgressRow = {
  progress_version: number; state_hash: string | null; current_level_key: string | null; current_lesson_key: string | null;
  current_lesson_engaged_seconds: number; current_level_engaged_seconds: number; progress_summary_json: string | null;
  progress_summary_visibility_status: string | null; progress_summary_based_on_version: number | null;
  progress_summary_version: number; progress_summary_state_hash: string | null;
};

type RecoveryIncidentCategory = "stale" | "device_mismatch" | "schema_migration_required" | "integrity_blocked" | "incomplete_receipt";

// Discrete per-attempt problem log — dedup scoped to (session, category),
// not a persistent per-learner-app state machine like PR-004's
// progress_integrity_incidents (rule 63: safe metadata only).
async function recordIncident(db: DbClient, input: {
  appId: string; learnerId: string; learnerSessionId: string; releaseId: string | null;
  category: RecoveryIncidentCategory; baseProgressVersion: number | null; baseStateHash: string | null;
  currentProgressVersion: number | null; currentStateHash: string | null; now: Date;
}) {
  const nowIso = input.now.toISOString();
  const existing = await db.get<{ id: string }>(`select id from progress_recovery_incidents
    where learner_session_id=? and category=? and status='open'`, [input.learnerSessionId, input.category]);
  if (existing) {
    await db.run(`update progress_recovery_incidents set attempt_count=attempt_count+1,
      current_progress_version=?,current_state_hash=?,updated_at=? where id=?`,
      [input.currentProgressVersion, input.currentStateHash, nowIso, existing.id]);
    return existing.id;
  }
  const id = randomUUID();
  await db.run(`insert into progress_recovery_incidents(id,app_id,learner_id,learner_session_id,release_id,category,
    base_progress_version,base_state_hash,current_progress_version,current_state_hash,status,attempt_count,
    created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,'open',1,?,?)`,
    [id, input.appId, input.learnerId, input.learnerSessionId, input.releaseId, input.category,
      input.baseProgressVersion, input.baseStateHash, input.currentProgressVersion, input.currentStateHash, nowIso, nowIso]);
  return id;
}

async function insertReceipt(db: DbClient, input: {
  context: AppProgressContext; session: SessionRow; recoveryInput: RecoverCurrentProgressInput;
  requestHash: string; result: "recovered" | "stale" | "rejected"; resultCode: string | null;
  newProgressVersion: number | null; newStateHash: string | null; now: Date;
}) {
  const id = randomUUID();
  await db.run(`insert into progress_recovery_receipts(id,learner_session_id,learner_id,app_id,device_session_id,
    recovery_capsule_id,recovery_sequence,base_progress_version,base_state_hash,new_progress_version,new_state_hash,
    release_id,deployment_id,request_hash,idempotency_key,result,result_code,created_at)
    values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, input.context.learnerSessionId, input.context.learnerId, input.context.appId, input.recoveryInput.deviceSessionId,
      input.recoveryInput.recoveryCapsuleId, input.recoveryInput.recoverySequence, input.recoveryInput.expectedProgressVersion,
      input.recoveryInput.baseStateHash, input.newProgressVersion, input.newStateHash, input.session.release_id,
      input.session.deployment_id, input.requestHash, input.recoveryInput.idempotencyKey, input.result, input.resultCode,
      input.now.toISOString()]);
  return id;
}

export type RecoverCurrentProgressInput = {
  deviceSessionId: string; credential: string; expectedProgressVersion: number; baseStateHash: string;
  recoverySequence: number; stateSchemaVersion: number; pendingState: unknown; recoveryCapsuleId: string;
  idempotencyKey: string; expectedIntegrityVersion?: number;
};

// PR-002's central recovery write. Rules 22-23: only ever valid strictly
// before the session's own signed hard expiry — never a post-expiry
// resurrection path (that's what the existing resumeLearnerSession/
// SESSION_HARD_EXPIRED handling already, correctly, forecloses).
export async function recoverCurrentProgress(context: AppProgressContext, input: RecoverCurrentProgressInput, now: Date) {
  const db = resolveDbClient();
  const session = await sessionFor(db, context);

  // Independently re-validates device/credential (same check
  // resumeLearnerSession already does) rather than trusting that resume
  // ran moments earlier in the same request flow.
  if (input.deviceSessionId !== session.device_session_id) throw new ProgressRecoveryError("SESSION_DEVICE_MISMATCH");
  if (digest(input.credential) !== session.resume_token_hash) throw new ProgressRecoveryError("SESSION_RESUME_PROOF_INVALID");
  if (session.status !== "active") throw new ProgressRecoveryError("SESSION_NOT_RESUMABLE");
  if (!session.hard_expires_at || now >= new Date(session.hard_expires_at)) throw new ProgressRecoveryError("SESSION_HARD_EXPIRED");

  const requestHash = digest(canonical(input));
  const existingReceipt = await db.get<ReceiptRow>(`select * from progress_recovery_receipts where learner_session_id=? and idempotency_key=?`,
    [context.learnerSessionId, input.idempotencyKey]);
  if (existingReceipt) {
    if (existingReceipt.request_hash !== requestHash) throw new ProgressRecoveryError("IDEMPOTENCY_KEY_REUSED");
    return { newProgressVersion: existingReceipt.new_progress_version, newStateHash: existingReceipt.new_state_hash,
      result: existingReceipt.result as "recovered" | "stale" | "rejected" };
  }

  const integrityGate = await validateProgressIntegrity({ learnerId: context.learnerId, appId: context.appId,
    environment: session.deployment_environment ?? "production", reason: "write",
    expectedIntegrityVersion: input.expectedIntegrityVersion, now });
  if (integrityGate.mutationBlocked) {
    await recordIncident(db, { appId: context.appId, learnerId: context.learnerId, learnerSessionId: context.learnerSessionId,
      releaseId: session.release_id, category: "integrity_blocked", baseProgressVersion: input.expectedProgressVersion,
      baseStateHash: input.baseStateHash, currentProgressVersion: null, currentStateHash: null, now });
    throw new ProgressRecoveryError("PROGRESS_INTEGRITY_BLOCKED");
  }

  if (!session.release_id) throw new ProgressRecoveryError("PROGRESS_MIGRATION_REQUIRED");
  let checked: { serialized: string };
  try {
    checked = await validateState(session.release_id, context.appId, input.stateSchemaVersion, input.pendingState);
  } catch (error) {
    if (error instanceof AppProgressError && error.code === "PROGRESS_SCHEMA_UNSUPPORTED") {
      await recordIncident(db, { appId: context.appId, learnerId: context.learnerId, learnerSessionId: context.learnerSessionId,
        releaseId: session.release_id, category: "schema_migration_required", baseProgressVersion: input.expectedProgressVersion,
        baseStateHash: input.baseStateHash, currentProgressVersion: null, currentStateHash: null, now });
      throw new ProgressRecoveryError("PROGRESS_MIGRATION_REQUIRED");
    }
    throw error;
  }

  const result = await resolveDbClient().transaction(async (db) => {
    const progressRow = await db.get<ProgressRow>(`select * from learner_app_progress where learner_id=? and app_id=?`,
      [context.learnerId, context.appId]);
    const currentVersion = progressRow?.progress_version ?? 0;
    const currentHash = progressRow?.state_hash ?? null;

    // Rules 27-28, 36: server-authoritative conflict protection — never
    // overwrites newer server state.
    if (currentVersion !== input.expectedProgressVersion || currentHash !== input.baseStateHash) {
      await recordIncident(db, { appId: context.appId, learnerId: context.learnerId, learnerSessionId: context.learnerSessionId,
        releaseId: session.release_id, category: "stale", baseProgressVersion: input.expectedProgressVersion,
        baseStateHash: input.baseStateHash, currentProgressVersion: currentVersion, currentStateHash: currentHash, now });
      await insertReceipt(db, { context, session, recoveryInput: input, requestHash, result: "stale",
        resultCode: "PROGRESS_RECOVERY_STALE", newProgressVersion: null, newStateHash: null, now });
      return { stale: true as const };
    }

    // Rule 48: recovery sequence must exceed any previously-accepted value for this session.
    const maxSequence = await db.get<{ maxSeq: number | null }>(`select max(recovery_sequence) as maxSeq from progress_recovery_receipts
      where learner_session_id=? and result='recovered'`, [context.learnerSessionId]);
    if (maxSequence?.maxSeq !== null && maxSequence?.maxSeq !== undefined && input.recoverySequence <= maxSequence.maxSeq) {
      await insertReceipt(db, { context, session, recoveryInput: input, requestHash, result: "rejected",
        resultCode: "PROGRESS_RECOVERY_SEQUENCE_CONFLICT", newProgressVersion: null, newStateHash: null, now });
      throw new ProgressRecoveryError("PROGRESS_RECOVERY_SEQUENCE_CONFLICT");
    }

    const nextVersion = currentVersion + 1;
    const timestamp = now.toISOString();
    const stateHash = computeCanonicalStateHash({ learnerId: context.learnerId, appId: context.appId,
      environment: session.deployment_environment ?? "production", progressVersion: nextVersion,
      schemaVersion: input.stateSchemaVersion, serializedState: checked.serialized });

    // Rules 41-42: recovery never advances level/lesson or infers a new
    // lesson completion — current_level_key/current_lesson_key (and the
    // summary fields) are carried over unchanged, not touched by the
    // ON CONFLICT UPDATE SET clause below.
    await db.run(`insert into learner_app_progress(learner_id,app_id,current_level_key,current_lesson_key,current_engaged_seconds,
      app_state,schema_version,current_state_json,current_lesson_engaged_seconds,current_level_engaged_seconds,progress_version,
      last_session_id,last_checkpoint_sequence,state_hash,progress_summary_json,progress_summary_visibility_status,
      progress_summary_based_on_version,progress_summary_version,progress_summary_state_hash,updated_at)
      values(?,?,?,?,0,?,?,?,?,?,?, ?,0,?,?,?,?,?,?,?)
      on conflict(learner_id,app_id) do update set current_state_json=excluded.current_state_json,
      app_state=excluded.app_state,schema_version=excluded.schema_version,progress_version=excluded.progress_version,
      state_hash=excluded.state_hash,updated_at=excluded.updated_at`,
      [context.learnerId, context.appId, progressRow?.current_level_key ?? null, progressRow?.current_lesson_key ?? null,
        checked.serialized, input.stateSchemaVersion, checked.serialized,
        progressRow?.current_lesson_engaged_seconds ?? 0, progressRow?.current_level_engaged_seconds ?? 0, nextVersion,
        context.learnerSessionId, stateHash, progressRow?.progress_summary_json ?? null,
        progressRow?.progress_summary_visibility_status ?? "current", progressRow?.progress_summary_based_on_version ?? null,
        progressRow?.progress_summary_version ?? 0, progressRow?.progress_summary_state_hash ?? null, timestamp]);

    // Decision 2: only the recovery path ever sets these — ordinary
    // checkpoints never touch learner_sessions for this.
    await db.run(`update learner_sessions set last_acknowledged_progress_version=?,last_acknowledged_progress_hash=?,
      updated_at=? where id=?`, [nextVersion, stateHash, timestamp, context.learnerSessionId]);

    await insertReceipt(db, { context, session, recoveryInput: input, requestHash, result: "recovered", resultCode: null,
      newProgressVersion: nextVersion, newStateHash: stateHash, now });

    await db.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'app_progress_recovered',?)",
      [randomUUID(), session.parent_user_id, JSON.stringify({ sessionId: context.learnerSessionId, appId: context.appId,
        progressVersion: nextVersion, recoverySequence: input.recoverySequence, stateHash })]);

    return { stale: false as const, newProgressVersion: nextVersion, newStateHash: stateHash };
  });

  if (result.stale) throw new ProgressRecoveryError("PROGRESS_RECOVERY_STALE");

  // Rule 69: recompute and validate canonical integrity before
  // acknowledgment — run after the write commits (not nested inside the
  // same transaction) since the write has already happened and this is a
  // fresh post-hoc confirmation, not a gate on the write itself.
  const postWrite = await validateProgressIntegrity({ learnerId: context.learnerId, appId: context.appId,
    environment: session.deployment_environment ?? "production", reason: "write", now });
  if (postWrite.classification !== "healthy") throw new ProgressRecoveryError("PROGRESS_INTEGRITY_BLOCKED");

  return { newProgressVersion: result.newProgressVersion, newStateHash: result.newStateHash, result: "recovered" as const };
}

// Rule 52: capsule/recovery-window closure bookkeeping — called from the
// existing finalize/secure-exit/hard-expiry-sweep/revocation call sites,
// not a new subsystem. Idempotent (only ever sets the first close).
export async function closeRecoveryWindow(sessionId: string,
  reason: "finalized" | "secure_exit" | "hard_expired" | "security_revoked" | "irrecoverable", now: Date) {
  await resolveDbClient().run(`update learner_sessions set recovery_closed_at=?,recovery_closed_reason=?
    where id=? and recovery_closed_at is null`, [now.toISOString(), reason, sessionId]);
}

// AU-004's reconcile-recovery: revalidates a receipt against what's
// actually stored now. Deliberately takes no pendingState/payload
// parameter at all — it can never invent or accept a missing target
// payload, only confirm or flag what already happened.
export async function reconcileRecoveryReceipt(receiptId: string, now: Date) {
  const db = resolveDbClient();
  const receipt = await db.get<ReceiptRow & { release_id: string | null }>(`select * from progress_recovery_receipts where id=?`,
    [receiptId]);
  if (!receipt) throw new ProgressRecoveryError("PROGRESS_RECOVERY_RECEIPT_NOT_FOUND");
  const progressRow = await db.get<{ progress_version: number; state_hash: string | null }>(
    `select progress_version,state_hash from learner_app_progress where learner_id=? and app_id=?`,
    [receipt.learner_id, receipt.app_id]);
  const confirmed = receipt.result === "recovered" &&
    progressRow?.progress_version === receipt.new_progress_version && progressRow?.state_hash === receipt.new_state_hash;
  if (receipt.result === "recovered" && !confirmed) {
    await recordIncident(db, { appId: receipt.app_id, learnerId: receipt.learner_id, learnerSessionId: receipt.learner_session_id,
      releaseId: receipt.release_id, category: "incomplete_receipt", baseProgressVersion: receipt.new_progress_version,
      baseStateHash: receipt.new_state_hash, currentProgressVersion: progressRow?.progress_version ?? null,
      currentStateHash: progressRow?.state_hash ?? null, now });
  }
  return { receiptId, confirmed };
}

type RecoveryIncidentRow = {
  id: string; app_id: string; learner_id: string; learner_session_id: string; release_id: string | null;
  category: RecoveryIncidentCategory; base_progress_version: number | null; base_state_hash: string | null;
  current_progress_version: number | null; current_state_hash: string | null; status: string; attempt_count: number;
  created_at: string; updated_at: string; resolved_at: string | null;
};

// GET /v1/admin/apps/{appId}/progress-recovery-incidents — safe metadata
// only (rule 63): app/learner/session reference, category, versions/
// hashes, status, attempt count, timestamps. No raw pendingState anywhere
// on this row to begin with.
export async function listRecoveryIncidents(appId: string, options: { status?: "open" | "resolved"; limit?: number; cursor?: string } = {}) {
  const bounded = Math.max(1, Math.min(100, options.limit ?? 50));
  const cursor = options.cursor ?? "";
  const statusClause = options.status ? "and status=?" : "";
  const params: Array<string | number> = options.status
    ? [appId, cursor, options.status, bounded + 1] : [appId, cursor, bounded + 1];
  const rows = await resolveDbClient().all<RecoveryIncidentRow>(`select * from progress_recovery_incidents where app_id=? and id>? ${statusClause}
    order by id limit ?`, params);
  const page = rows.slice(0, bounded);
  return {
    items: page.map((row) => ({
      incidentId: row.id, appId: row.app_id, learnerId: row.learner_id, learnerSessionId: row.learner_session_id,
      releaseId: row.release_id, category: row.category, baseProgressVersion: row.base_progress_version,
      baseStateHash: row.base_state_hash, currentProgressVersion: row.current_progress_version,
      currentStateHash: row.current_state_hash, status: row.status, attemptCount: row.attempt_count,
      createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at,
    })),
    nextCursor: rows.length > bounded ? page[page.length - 1].id : null,
  };
}

