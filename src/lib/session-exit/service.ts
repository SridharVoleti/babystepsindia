import { createHash, randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import type { AppProgressContext } from "@/lib/app-progress/service";
import { validateProgressIntegrity } from "@/lib/progress-integrity/service";
import { finalizeLearnerSession } from "@/lib/session-finalization/service";

export class SessionExitError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "SessionExitError";
  }
}

type SessionExitRow = {
  id: string;
  learner_id: string;
  app_id: string;
  device_session_id: string;
  release_id: string | null;
  deployment_environment: string | null;
  status: string;
  version: number;
  hard_expires_at: string | null;
  connected_elapsed_seconds: number;
  intentional_exit_state: string;
  last_exit_acknowledged_progress_version: number | null;
};

type ExitReceipt = {
  request_hash: string;
  response_json: string;
};

export type MarkResumableInput = {
  expectedSessionVersion: number;
  lastAcknowledgedProgressVersion: number;
  idempotencyKey: string;
};

export type FinishSessionInput = {
  expectedSessionVersion: number;
  finalProgressVersion: number;
  reason: "intentional_finish";
  idempotencyKey: string;
};

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function sessionRow(db: DbClient, sessionId: string): Promise<SessionExitRow> {
  const row = await db.get<SessionExitRow>("select * from learner_sessions where id=?", [sessionId]);
  if (!row) throw new SessionExitError("LEARNER_SESSION_NOT_FOUND");
  return row;
}

function assertBinding(row: SessionExitRow, context: AppProgressContext) {
  if (row.id !== context.learnerSessionId || row.learner_id !== context.learnerId || row.app_id !== context.appId) {
    throw new SessionExitError("LEARNER_SESSION_BINDING_MISMATCH");
  }
}

function assertBeforeHardExpiry(row: SessionExitRow, now: Date) {
  if (!row.hard_expires_at || now >= new Date(row.hard_expires_at)) {
    throw new SessionExitError("SESSION_HARD_EXPIRED");
  }
}

async function acknowledgedProgressVersion(db: DbClient, row: SessionExitRow) {
  return Number((await db.get<{ progress_version: number }>(
    "select progress_version from learner_app_progress where learner_id=? and app_id=?",
    [row.learner_id, row.app_id],
  ))?.progress_version ?? 0);
}

function allowedActions(status: string) {
  if (status === "starting") return ["cancel_start"] as const;
  if (status === "active") return ["resume_later", "finish_now"] as const;
  if (status === "resumable") return ["resume", "finish_now"] as const;
  return [] as const;
}

async function exitResponse(db: DbClient, row: SessionExitRow) {
  return {
    sessionId: row.id,
    sessionStatus: row.status,
    sessionVersion: row.version,
    hardExpiresAt: row.hard_expires_at,
    lastAcknowledgedProgressVersion: await acknowledgedProgressVersion(db, row),
    allowedActions: [...allowedActions(row.status)],
  };
}

type SessionExitResult = Awaited<ReturnType<typeof exitResponse>> & Record<string, unknown>;

export async function getSessionExitState(context: AppProgressContext, now: Date) {
  const db = resolveDbClient();
  const row = await sessionRow(db, context.learnerSessionId);
  assertBinding(row, context);
  if (["active", "resumable"].includes(row.status)) assertBeforeHardExpiry(row, now);
  return exitResponse(db, row);
}

async function receipt(db: DbClient, sessionId: string, action: "resume_later" | "finish_now", key: string) {
  return db.get<ExitReceipt>(`select request_hash,response_json from session_exit_transition_receipts
    where learner_session_id=? and action=? and idempotency_key=?`, [sessionId, action, key]);
}

function replayOrThrow(existing: ExitReceipt | undefined, requestHash: string) {
  if (!existing) return undefined;
  if (existing.request_hash !== requestHash) throw new SessionExitError("IDEMPOTENCY_KEY_REUSED");
  return JSON.parse(existing.response_json) as SessionExitResult;
}

async function insertReceipt(db: DbClient, input: {
  row: SessionExitRow;
  context: AppProgressContext;
  action: "resume_later" | "finish_now";
  expectedSessionVersion: number;
  priorSessionVersion: number;
  acknowledgedProgressVersion: number;
  idempotencyKey: string;
  requestHash: string;
  result: SessionExitResult;
  now: Date;
}) {
  const timestamp = input.now.toISOString();
  await db.run(`insert into session_exit_transition_receipts(id,learner_session_id,app_id,device_session_id,
    release_id,app_principal_id,action,expected_session_version,prior_session_version,new_session_version,
    acknowledged_progress_version,idempotency_key,request_hash,result_status,response_json,created_at,completed_at)
    values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [randomUUID(), input.row.id, input.row.app_id,
      input.row.device_session_id, input.row.release_id, input.context.principalId, input.action,
      input.expectedSessionVersion, input.priorSessionVersion, input.result.sessionVersion,
      input.acknowledgedProgressVersion, input.idempotencyKey, input.requestHash, input.result.sessionStatus,
      JSON.stringify(input.result), timestamp, timestamp]);
}

export async function markSessionResumable(context: AppProgressContext, input: MarkResumableInput, now: Date) {
  const requestHash = digest(input);
  const outerDb = resolveDbClient();
  const replay = replayOrThrow(await receipt(outerDb, context.learnerSessionId, "resume_later", input.idempotencyKey), requestHash);
  if (replay) return replay;

  return outerDb.transaction(async (db) => {
    const existingReplay = replayOrThrow(await receipt(db, context.learnerSessionId, "resume_later", input.idempotencyKey), requestHash);
    if (existingReplay) return existingReplay;
    const row = await sessionRow(db, context.learnerSessionId);
    assertBinding(row, context);
    assertBeforeHardExpiry(row, now);
    const currentProgressVersion = await acknowledgedProgressVersion(db, row);
    if (currentProgressVersion !== input.lastAcknowledgedProgressVersion) {
      throw new SessionExitError("FINAL_PROGRESS_NOT_ACKNOWLEDGED");
    }

    if (row.status === "resumable") {
      if (row.last_exit_acknowledged_progress_version !== input.lastAcknowledgedProgressVersion) {
        throw new SessionExitError("LEARNER_SESSION_VERSION_CONFLICT");
      }
      const result = await exitResponse(db, row);
      await insertReceipt(db, { row, context, action: "resume_later", expectedSessionVersion: input.expectedSessionVersion,
        priorSessionVersion: row.version, acknowledgedProgressVersion: currentProgressVersion,
        idempotencyKey: input.idempotencyKey, requestHash, result, now });
      return result;
    }
    if (row.status !== "active") throw new SessionExitError("SESSION_NOT_ACTIVE");
    if (row.version !== input.expectedSessionVersion) throw new SessionExitError("LEARNER_SESSION_VERSION_CONFLICT");

    const integrity = await validateProgressIntegrity({ learnerId: row.learner_id, appId: row.app_id,
      environment: row.deployment_environment ?? "production", reason: "write", now });
    if (integrity.mutationBlocked) throw new SessionExitError("PROGRESS_INTEGRITY_MUTATION_BLOCKED");

    await db.run(`update learner_sessions set status='resumable',intentional_exit_state='resumable',
      intentional_exit_reason='intentional_resume_later',last_exit_acknowledged_progress_version=?,
      resumable_marked_at=?,active_segment_started_at=null,disconnected_at=null,resume_deadline=null,
      exit_transition_version=exit_transition_version+1,version=version+1,updated_at=? where id=? and status='active'`,
      [currentProgressVersion, now.toISOString(), now.toISOString(), row.id]);
    const updated = await sessionRow(db, row.id);
    const result = await exitResponse(db, updated);
    await insertReceipt(db, { row, context, action: "resume_later", expectedSessionVersion: input.expectedSessionVersion,
      priorSessionVersion: row.version, acknowledgedProgressVersion: currentProgressVersion,
      idempotencyKey: input.idempotencyKey, requestHash, result, now });
    await db.run("insert into account_events(id,parent_user_id,event_type,metadata) select ?,parent_user_id,?,? from learner_sessions where id=?",
      [randomUUID(), "learner_session_marked_resumable", JSON.stringify({ sessionId: row.id,
        appId: row.app_id, progressVersion: currentProgressVersion, sessionVersion: updated.version }), row.id]);
    return result;
  });
}

export async function finishSessionIntentionally(context: AppProgressContext, input: FinishSessionInput, now: Date) {
  if (input.reason !== "intentional_finish") throw new SessionExitError("SESSION_END_REASON_INVALID");
  const requestHash = digest(input);
  const outerDb = resolveDbClient();
  const replay = replayOrThrow(await receipt(outerDb, context.learnerSessionId, "finish_now", input.idempotencyKey), requestHash);
  if (replay) return replay;

  return outerDb.transaction(async (db) => {
    const existingReplay = replayOrThrow(await receipt(db, context.learnerSessionId, "finish_now", input.idempotencyKey), requestHash);
    if (existingReplay) return existingReplay;
    const row = await sessionRow(db, context.learnerSessionId);
    assertBinding(row, context);
    assertBeforeHardExpiry(row, now);
    if (!["active", "resumable"].includes(row.status)) throw new SessionExitError("SESSION_NOT_ACTIVE");
    const currentProgressVersion = await acknowledgedProgressVersion(db, row);
    if (currentProgressVersion !== input.finalProgressVersion) {
      throw new SessionExitError("FINAL_PROGRESS_NOT_ACKNOWLEDGED");
    }

    const finalization = await finalizeLearnerSession(context, {
      expectedSessionVersion: input.expectedSessionVersion,
      finalProgressVersion: input.finalProgressVersion,
      endReasonCode: "intentional_finish",
      completionIdempotencyKey: input.idempotencyKey,
      reportedConnectedSeconds: row.connected_elapsed_seconds,
    }, now);
    const updated = await sessionRow(db, row.id);
    const result = { ...finalization, ...(await exitResponse(db, updated)) };
    await insertReceipt(db, { row, context, action: "finish_now", expectedSessionVersion: input.expectedSessionVersion,
      priorSessionVersion: row.version, acknowledgedProgressVersion: currentProgressVersion,
      idempotencyKey: input.idempotencyKey, requestHash, result, now });
    return result;
  });
}

