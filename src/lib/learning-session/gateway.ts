import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { isoWeekKey } from "@/lib/learning-session/week";
import { purgeLaunchDataForSession } from "@/lib/app-launch/service";
import { finalizeSessionAutomatically } from "@/lib/session-finalization/service";
import { reserveTechnicalCredit, restoreTechnicalCredit, consumeTechnicalCredit } from "@/lib/session-credit/service";
import { fundStandardSession, releaseStandardReservation, consumeStandardReservation } from "@/lib/session-credit-standard/service";
import { issueSessionEnvelope } from "@/lib/session-runtime/envelope";
import { activateAppGrant } from "@/lib/app-authorization/service";
import { evaluateAccessFresh } from "@/lib/entitlement-access/service";
import { applyDailyContribution } from "@/lib/db/analytics-contribution-repo";
import type { ValidatedContribution } from "@/lib/analytics/validation";
import { deriveAgeBand } from "@/lib/analytics/age-band";
import { kolkataCalendarDate, splitKolkataEngagedSeconds } from "@/lib/analytics/kolkata-interval";
import type { AppProgressContext } from "@/lib/app-progress/service";
import { isMandatoryProgressApp, migrateLearnerProgressToReleaseSchema } from "@/lib/progress-schema-registry/service";
import { validateProgressIntegrity } from "@/lib/progress-integrity/service";
import { closeRecoveryWindow } from "@/lib/progress-recovery/service";
import { AppAvailabilityError, assertStartAvailability } from "@/lib/app-availability/service";
import { enqueueStandardSessionConsistency, processQueuedStandardSessionConsistency } from "@/lib/consistency/service";

export class LearnerSessionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "LearnerSessionError";
  }
}

type SessionRow = {
  id: string; learner_id: string; app_id: string; parent_user_id: string;
  parent_session_id: string; device_session_id: string; week_key: string;
  week_timezone: string; weekly_slot_number: number | null; replacement_credit_id: string | null;
  source: "normal" | "replacement" | "technical_credit" | "standard_monthly"; status: string;
  // SC-003: reserve-then-activate lifecycle fields.
  funding_state: "reserved" | "consumed" | "released" | "expired";
  reserved_at: string | null; reservation_expires_at: string | null;
  schedule_authorization_id: string;
  started_at: string; disconnected_at: string | null;
  resume_deadline: string | null; cumulative_disconnected_seconds: number;
  connected_elapsed_seconds: number; verified_active_seconds: number;
  // SC-001: browser-local session runtime — usable-launch moment + hard
  // server expiry replace recurring heartbeats.
  usable_launch_established_at: string | null; active_segment_started_at: string | null; hard_expires_at: string | null;
  maximum_connected_seconds: number;
  // SC-002: which standard-credit batch funded this session and its weekly ordinal (1..3).
  standard_credit_batch_id: string | null; weekly_session_ordinal: number | null;
  resume_token_hash: string; ended_at: string | null;
  end_reason: string | null; version: number; created_at: string; updated_at: string;
  interruption_episode_count: number; final_progress_version: number | null;
  current_level_key: string | null;
  session_credit_id: string | null;
  deployment_id: string | null; release_id: string | null; deployment_environment: string | null;
  // EN-002: the effective-entitlement binding fresh-evaluated and persisted
  // at Start — resume checks against this binding (GAP-101), not a
  // re-derived live one.
  effective_entitlement_id: string | null;
};

// Builds the contribution inputs rather than applying them — applyDailyContribution
// runs its own async DbClient transaction, which can't nest inside this
// file's legacy-shaped sequencing without collecting inputs first.
// Callers apply the returned list (sequentially, never Promise.all — see
// sqlite-adapter.ts) after their own transaction commits.
function contributeSessionRuntime(learnerDob: string, row: SessionRow, contributionId: string, now: Date, deltas: {
  engagedSeconds: number; sessionsStarted: number; sessionsInterrupted: number;
}): ValidatedContribution[] {
  const common = { learnerId: row.learner_id, appId: row.app_id, levelKey: row.current_level_key ?? "unassigned" };
  const eventDate = kolkataCalendarDate(now);
  const contributions: ValidatedContribution[] = [];
  if (deltas.sessionsStarted > 0 || deltas.sessionsInterrupted > 0) {
    contributions.push({ contributionId, activityDate: eventDate, ...common,
      ageBand: deriveAgeBand(learnerDob, eventDate), deltas: { engagedSeconds: 0,
        sessionsStarted: deltas.sessionsStarted, sessionsCompleted: 0,
        sessionsInterrupted: deltas.sessionsInterrupted, lessonsCompleted: 0 } });
  }
  if (deltas.engagedSeconds > 0) {
    const segmentStart = row.active_segment_started_at
      ? new Date(row.active_segment_started_at)
      : new Date(now.getTime() - deltas.engagedSeconds * 1000);
    for (const chunk of splitKolkataEngagedSeconds(segmentStart, deltas.engagedSeconds)) {
      contributions.push({ contributionId: `${contributionId}:engaged:${chunk.activityDate}`,
        activityDate: chunk.activityDate, ...common, ageBand: deriveAgeBand(learnerDob, chunk.activityDate),
        deltas: { engagedSeconds: chunk.engagedSeconds, sessionsStarted: 0, sessionsCompleted: 0,
          sessionsInterrupted: 0, lessonsCompleted: 0 } });
    }
  }
  return contributions;
}

async function contributeSessionRuntimeFor(db: DbClient, row: SessionRow, contributionId: string, now: Date, deltas: {
  engagedSeconds: number; sessionsStarted: number; sessionsInterrupted: number;
}): Promise<ValidatedContribution[]> {
  const learner = await db.get<{ date_of_birth: string }>("select date_of_birth from learners where id=?", [row.learner_id]);
  if (!learner) throw new LearnerSessionError("LEARNER_NOT_FOUND");
  return contributeSessionRuntime(learner.date_of_birth, row, contributionId, now, deltas);
}

async function applyContributions(contributions: ValidatedContribution[]): Promise<void> {
  for (const contribution of contributions) await applyDailyContribution(contribution);
}

async function activeParent(db: DbClient, parentUserId: string) {
  const row = await db.get<{ account_status: string }>("select account_status from profiles where id=?", [parentUserId]);
  if (!row) throw new LearnerSessionError("PARENT_PROFILE_NOT_FOUND");
  if (row.account_status === "deleted") throw new LearnerSessionError("ACCOUNT_DELETED");
  if (row.account_status === "suspended") throw new LearnerSessionError("ACCOUNT_SUSPENDED");
}

async function ownedLearners(db: DbClient, parentUserId: string) {
  await activeParent(db, parentUserId);
  return db.all<{ id: string; displayName: string; avatarId: string | null }>(
    "select id, display_name displayName, avatar_id avatarId from learners where owner_parent_id=? order by created_at,id",
    [parentUserId]);
}

export async function getLearnerSelection(parentSessionId: string, parentUserId: string, expiresAt: string) {
  const db = resolveDbClient();
  const learners = await ownedLearners(db, parentUserId);
  await db.run("delete from learner_selection_contexts where expires_at <= ?", [new Date().toISOString()]);
  let selected = await db.get<{ id: string }>(
    "select selected_learner_id id from learner_selection_contexts where parent_session_id=? and parent_user_id=?",
    [parentSessionId, parentUserId]);
  if (!selected && learners.length === 1) {
    await selectLearner(parentSessionId, parentUserId, learners[0].id, expiresAt);
    selected = { id: learners[0].id };
  }
  return {
    learners,
    selectedLearnerId: selected?.id ?? null,
    requiresSelection: learners.length > 1 && !selected,
    requiresLearnerCreation: learners.length === 0,
  };
}

export async function selectLearner(
  parentSessionId: string, parentUserId: string, learnerId: string, expiresAt: string,
) {
  const db = resolveDbClient();
  await activeParent(db, parentUserId);
  const owned = await db.get("select 1 as x from learners where id=? and owner_parent_id=?", [learnerId, parentUserId]);
  if (!owned) throw new LearnerSessionError("LEARNER_NOT_FOUND");
  const now = new Date().toISOString();
  await db.run(
    `insert into learner_selection_contexts(parent_session_id,parent_user_id,selected_learner_id,selected_at,expires_at)
     values(?,?,?,?,?) on conflict(parent_session_id) do update set
     parent_user_id=excluded.parent_user_id,selected_learner_id=excluded.selected_learner_id,
     selected_at=excluded.selected_at,expires_at=excluded.expires_at`,
    [parentSessionId, parentUserId, learnerId, now, expiresAt]);
  return { selectedLearnerId: learnerId, selectedAt: now, expiresAt };
}

type StartInput = {
  actorSessionId: string; parentUserId: string; selectedLearnerId: string;
  learnerId: string; appId: string; deviceSessionId: string;
  scheduleAuthorizationId: string; scheduleAuthorized: boolean;
  idempotencyKey: string; now: Date;
  fundingSource?: "normal" | "technical_credit" | "standard_monthly"; creditId?: string;
  deployment: {
    deploymentId: string; releaseId: string; environment: string;
    origin: string; launchPath: string; compatibilityPassed: boolean; dispatchBlocked: boolean;
  };
};

function secret() {
  const value = process.env.LEARNING_SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("LEARNING_SESSION_SECRET must be at least 32 characters");
  return value;
}

function resumeCredential(sessionId: string, deviceId: string) {
  return createHmac("sha256", secret()).update(`resume:${sessionId}:${deviceId}`).digest("base64url");
}

function tokenFor(row: Pick<SessionRow, "id" | "learner_id" | "app_id" | "device_session_id">, now: Date) {
  const expiry = Math.floor(now.getTime() / 1000) + 300;
  const payload = `${row.id}.${row.learner_id}.${row.app_id}.${row.device_session_id}.${expiry}`;
  const signature = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyToken(row: SessionRow, token: string, deviceId: string, now: Date) {
  const parts = token.split(".");
  if (parts.length !== 6) throw new LearnerSessionError("SESSION_TOKEN_INVALID");
  const [sessionId, learnerId, appId, tokenDeviceId, expiryText, signature] = parts;
  const payload = parts.slice(0, 5).join(".");
  const expected = createHmac("sha256", secret()).update(payload).digest("base64url");
  const validSignature = signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!validSignature || sessionId !== row.id || learnerId !== row.learner_id ||
    appId !== row.app_id || tokenDeviceId !== row.device_session_id || deviceId !== row.device_session_id ||
    Number(expiryText) < Math.floor(now.getTime() / 1000)) {
    throw new LearnerSessionError("SESSION_TOKEN_INVALID");
  }
}

function startResponse(row: SessionRow, now: Date) {
  const credential = resumeCredential(row.id, row.device_session_id);
  return {
    sessionId: row.id, learnerId: row.learner_id, appId: row.app_id,
    status: row.status, source: row.source, weeklySlotNumber: row.weekly_slot_number,
    weeklySessionOrdinal: row.weekly_session_ordinal, reservationExpiresAt: row.reservation_expires_at,
    weekKey: row.week_key, connectedElapsedSeconds: row.connected_elapsed_seconds,
    remainingConnectedSeconds: row.maximum_connected_seconds - row.connected_elapsed_seconds,
    sessionToken: tokenFor(row, now), resumeCredential: credential,
  };
}

// SC-003 business rules 23-28: shared release semantics for both an expired
// (lazy/scheduled-swept) reservation and an explicit learner cancellation.
// Never touches weekly funded usage — that only ever increments at usable
// launch, so a reservation that never got there has nothing to undo there.
async function releaseStartReservation(db: DbClient, row: SessionRow, reason: string, now: Date) {
  if (row.source === "standard_monthly" && row.standard_credit_batch_id) {
    await releaseStandardReservation(row.standard_credit_batch_id, now);
  } else if (row.source === "technical_credit" && row.session_credit_id) {
    await restoreTechnicalCredit(row.session_credit_id, row.id, now);
  }
  await db.run(
    `update learner_sessions set status='cancelled_before_launch',funding_state='released',
     ended_at=?,end_reason=?,version=version+1,updated_at=? where id=? and status='starting'`,
    [now.toISOString(), reason, now.toISOString(), row.id]);
  await purgeLaunchDataForSession(row.id);
  await db.run(
    "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?, 'learner_session_start_cancelled',?)",
    [randomUUID(), row.parent_user_id, JSON.stringify({ sessionId: row.id, learnerId: row.learner_id,
      appId: row.app_id, reason })]);
}

export async function startLearnerSession(input: StartInput) {
  const outerDb = resolveDbClient();
  await activeParent(outerDb, input.parentUserId);
  if (input.selectedLearnerId !== input.learnerId) throw new LearnerSessionError("LEARNER_SELECTION_MISMATCH");
  const learner = await outerDb.get<{ owner_parent_id: string; timezone: string }>(
    "select owner_parent_id,timezone from learners where id=?", [input.learnerId]);
  if (!learner || learner.owner_parent_id !== input.parentUserId) throw new LearnerSessionError("LEARNER_NOT_FOUND");
  // EN-002 business rule 11: Start re-evaluates effective access fresh,
  // before any credit reservation, rather than trusting a caller-supplied flag.
  const access = await evaluateAccessFresh({ learnerId: input.learnerId, appId: input.appId,
    environment: input.deployment.environment, useCase: "start", now: input.now });
  if (!access.allowed) throw new LearnerSessionError("ENTITLEMENT_INACTIVE");
  if (access.state === "grace" && !(input.fundingSource === "standard_monthly" ||
    input.fundingSource === "technical_credit")) throw new LearnerSessionError("ENTITLEMENT_INACTIVE");
  const technicalCredit=input.fundingSource==="technical_credit";
  if (technicalCredit&&!input.creditId) throw new LearnerSessionError("SESSION_CREDIT_BINDING_MISMATCH");
  if (!technicalCredit&&!input.scheduleAuthorized) throw new LearnerSessionError("APP_SESSION_NOT_SCHEDULED");
  if (input.deployment.dispatchBlocked) throw new LearnerSessionError("APP_DEPLOYMENT_WINDOW_BLOCKED");
  if (!input.deployment.compatibilityPassed) {
    throw new LearnerSessionError("RELEASE_BACKWARD_COMPATIBILITY_FAILED");
  }
  const canonical = JSON.stringify({ learnerId: input.learnerId, appId: input.appId,
    scheduleAuthorizationId: input.scheduleAuthorizationId, deviceSessionId: input.deviceSessionId,
    deploymentId: input.deployment.deploymentId, releaseId: input.deployment.releaseId,
    fundingSource:input.fundingSource??"normal",creditId:input.creditId??null });
  const hash = createHash("sha256").update(canonical).digest("hex");
  const existing = await outerDb.get<{ request_hash: string; session_id: string; status: string }>(
    "select request_hash,session_id,status from session_start_requests where actor_session_id=? and learner_id=? and idempotency_key=?",
    [input.actorSessionId, input.learnerId, input.idempotencyKey]);
  if (existing) {
    if (existing.request_hash !== hash) throw new LearnerSessionError("IDEMPOTENCY_KEY_REUSED");
    const row = (await outerDb.get<SessionRow>("select * from learner_sessions where id=?", [existing.session_id]))!;
    return startResponse(row, input.now);
  }

  const standardMonthly = input.fundingSource === "standard_monthly";
  const finalRow = await resolveDbClient().transaction(async (db) => {
    // UL-004 API-UL-015: check authoritative server-time availability
    // inside the Start transaction before any funding/session mutation.
    try {
      // Older billing acceptance fixtures use a synthetic payment-provider
      // environment named "test" as the deployment environment too. It is
      // never a platform environment; keep that compatibility test-only.
      const availabilityEnvironment = process.env.NODE_ENV === "test" && input.deployment.environment === "test"
        ? "production" : input.deployment.environment;
      await assertStartAvailability(input.appId, availabilityEnvironment, input.now);
    } catch (error) {
      if (error instanceof AppAvailabilityError) throw new LearnerSessionError(error.code);
      throw new LearnerSessionError("APP_AVAILABILITY_UNKNOWN");
    }
    // SC-003 business rule 32: lazy cleanup during starts — a learner's own
    // expired reservation is released here so a retry never has to wait for
    // the scheduled sweep.
    const reservedRow = await db.get<SessionRow>(
      "select * from learner_sessions where learner_id=? and status in ('starting','active','disconnected','resumable')",
      [input.learnerId]);
    if (reservedRow) {
      const expired = reservedRow.status === "starting" && reservedRow.reservation_expires_at !== null &&
        reservedRow.reservation_expires_at <= input.now.toISOString();
      if (!expired) throw new LearnerSessionError("LEARNER_SESSION_IN_PROGRESS");
      await releaseStartReservation(db, reservedRow, "reservation_expired", input.now);
    }
    const weekKey = isoWeekKey(input.now, learner.timezone);
    const timestamp = input.now.toISOString();
    const sessionId = randomUUID();
    let slot:number|null=null;
    let standardCreditBatchId:string|null=null;
    let weeklySessionOrdinal:number|null=null;
    if(technicalCredit){await reserveTechnicalCredit(input.creditId!,input.learnerId,input.appId,sessionId,input.now);}
    else if(standardMonthly){
      const funded=await fundStandardSession({learnerId:input.learnerId,appId:input.appId,timezone:learner.timezone,now:input.now});
      standardCreditBatchId=funded.batchId;weeklySessionOrdinal=funded.weeklySessionOrdinal;
    }
    else{
      await db.run(`insert into learner_app_week_usage(learner_id,app_id,week_key,week_timezone,normal_sessions_started,updated_at)
       values(?,?,?,?,0,?) on conflict(learner_id,app_id,week_key) do nothing`,[input.learnerId,input.appId,weekKey,learner.timezone,timestamp]);
      const usage=(await db.get<{normal_sessions_started:number}>("select normal_sessions_started from learner_app_week_usage where learner_id=? and app_id=? and week_key=?",
       [input.learnerId,input.appId,weekKey]))!;
      if(usage.normal_sessions_started>=2)throw new LearnerSessionError("WEEKLY_SESSION_LIMIT_REACHED");slot=usage.normal_sessions_started+1;
    }
    const credential = resumeCredential(sessionId, input.deviceSessionId);
    await db.run(
      `insert into session_start_requests(actor_session_id,learner_id,idempotency_key,request_hash,status,created_at)
       values(?,?,?,?, 'processing',?)`,
      [input.actorSessionId, input.learnerId, input.idempotencyKey, hash, timestamp]);
    if(!technicalCredit&&!standardMonthly)await db.run(
      `update learner_app_week_usage set normal_sessions_started=?,version=version+1,updated_at=?
       where learner_id=? and app_id=? and week_key=?`,
      [slot, timestamp, input.learnerId, input.appId, weekKey]);
    const source=technicalCredit?"technical_credit":standardMonthly?"standard_monthly":"normal";
    const reservationExpiresAt=new Date(input.now.getTime()+300_000).toISOString();
    await db.run(
      `insert into learner_sessions(id,learner_id,app_id,parent_user_id,parent_session_id,device_session_id,
       week_key,week_timezone,weekly_slot_number,source,session_credit_id,standard_credit_batch_id,weekly_session_ordinal,
       status,funding_state,reserved_at,reservation_expires_at,schedule_authorization_id,started_at,
       resume_token_hash,deployment_id,release_id,deployment_environment,deployment_origin,
       launch_path,session_expires_at,effective_entitlement_id,effective_entitlement_version_at_start,
       allocation_source_entitlement_period_id,created_at,updated_at)
       values(?,?,?,?,?,?,?,?,?,?,?,?,?,'starting','reserved',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [sessionId, input.learnerId, input.appId, input.parentUserId, input.actorSessionId,
      input.deviceSessionId, weekKey, learner.timezone, slot, source,
      technicalCredit?(input.creditId ?? null):null, standardCreditBatchId, weeklySessionOrdinal,
      timestamp, reservationExpiresAt,
      technicalCredit?"technical-credit":input.scheduleAuthorizationId,
      timestamp, createHash("sha256").update(credential).digest("hex"),
      input.deployment.deploymentId, input.deployment.releaseId, input.deployment.environment,
      input.deployment.origin, input.deployment.launchPath,
      new Date(input.now.getTime() + 60 * 60_000).toISOString(),
      access.effectiveEntitlementId, access.effectiveEntitlementVersion, access.coveringPeriodId,
      timestamp, timestamp]);
    await db.run(
      `update session_start_requests set session_id=?,status='completed',completed_at=?
       where actor_session_id=? and learner_id=? and idempotency_key=?`,
      [sessionId, timestamp, input.actorSessionId, input.learnerId, input.idempotencyKey]);
    await db.run(
      "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?, 'learner_session_started',?)",
      [randomUUID(), input.parentUserId, JSON.stringify({ sessionId, learnerId: input.learnerId,
      appId: input.appId, weekKey, weeklySlotNumber: slot, weeklySessionOrdinal, fundingSource: source })]);
    return (await db.get<SessionRow>("select * from learner_sessions where id=?", [sessionId]))!;
  });
  return startResponse(finalRow, input.now);
}

async function sessionRow(db: DbClient, sessionId: string): Promise<SessionRow> {
  const row = await db.get<SessionRow>("select * from learner_sessions where id=?", [sessionId]);
  if (!row) throw new LearnerSessionError("SESSION_NOT_FOUND");
  await activeParent(db, row.parent_user_id);
  return row;
}

function assertContextBinding(row: SessionRow, context: AppProgressContext) {
  if (row.learner_id !== context.learnerId || row.app_id !== context.appId) {
    throw new LearnerSessionError("LEARNER_SESSION_BINDING_MISMATCH");
  }
}

// SC-001: the platform records only the usable-launch moment (set once, at
// LA-001 exchange) and a fixed hard expiry 3600 seconds later. Everything in
// between is client-reported and capped — there is no recurring heartbeat.
export async function establishUsableLaunch(sessionId: string, now: Date) {
  const db = resolveDbClient();
  const row = await db.get<{ usable_launch_established_at: string | null; hard_expires_at: string | null;
    maximum_connected_seconds: number }>(
    "select usable_launch_established_at,hard_expires_at,maximum_connected_seconds from learner_sessions where id=?",
    [sessionId]);
  if (!row) throw new LearnerSessionError("SESSION_NOT_FOUND");
  if (row.usable_launch_established_at && row.hard_expires_at) {
    return { usableLaunchEstablishedAt: row.usable_launch_established_at, hardExpiresAt: row.hard_expires_at,
      maximumConnectedSeconds: row.maximum_connected_seconds, alreadyEstablished: true };
  }
  const usableLaunchEstablishedAt = now.toISOString();
  const hardExpiresAt = new Date(now.getTime() + 3600_000).toISOString();
  await db.run(
    "update learner_sessions set usable_launch_established_at=?,active_segment_started_at=?,hard_expires_at=?,updated_at=? where id=?",
    [usableLaunchEstablishedAt, usableLaunchEstablishedAt, hardExpiresAt, usableLaunchEstablishedAt, sessionId]);
  return { usableLaunchEstablishedAt, hardExpiresAt, maximumConnectedSeconds: row.maximum_connected_seconds,
    alreadyEstablished: false };
}

// SC-003: the app backend confirms usable launch only after its browser
// runtime has actually initialized (LA-002 dual proof required by the
// caller/route). This is what atomically converts starting/reserved into
// active/consumed — establishing the SC-001 clock and issuing the signed
// envelope only now, never at LA-001 exchange time.
export async function confirmUsableLaunch(context: AppProgressContext, input: {
  runtimeInitializationId: string; runtimeVersion: number; expectedSessionVersion: number;
  idempotencyKey: string; now: Date;
}) {
  const db = resolveDbClient();
  // `now` is server-observed, not part of what makes two requests "the same
  // request" — excluded from the hash so a same-payload retry a moment
  // later is still recognized as identical (matches finalizeLearnerSession).
  const requestHash = createHash("sha256").update(JSON.stringify({ runtimeInitializationId: input.runtimeInitializationId,
    runtimeVersion: input.runtimeVersion, expectedSessionVersion: input.expectedSessionVersion })).digest("hex");
  const existingReceipt = await db.get<{ request_hash: string; response_json: string }>(
    `select request_hash,response_json from usable_launch_requests
     where learner_session_id=? and app_principal_id=? and idempotency_key=?`,
    [context.learnerSessionId, context.principalId, input.idempotencyKey]);
  if (existingReceipt) {
    if (existingReceipt.request_hash !== requestHash) throw new LearnerSessionError("IDEMPOTENCY_KEY_REUSED");
    return JSON.parse(existingReceipt.response_json);
  }
  const row = await sessionRow(db, context.learnerSessionId);
  assertContextBinding(row, context);
  if (row.status === "active") throw new LearnerSessionError("USABLE_LAUNCH_ALREADY_CONFIRMED");
  if (row.status !== "starting") throw new LearnerSessionError("SESSION_NOT_USABLE");
  if (row.reservation_expires_at === null || row.reservation_expires_at <= input.now.toISOString()) {
    await releaseStartReservation(db, row, "reservation_expired", input.now);
    throw new LearnerSessionError("SESSION_START_RESERVATION_EXPIRED");
  }
  if (row.version !== input.expectedSessionVersion) throw new LearnerSessionError("LEARNER_SESSION_VERSION_CONFLICT");
  if (!row.deployment_id || !row.release_id || !row.deployment_environment) {
    throw new LearnerSessionError("USABLE_LAUNCH_CONTEXT_MISMATCH");
  }
  // EN-002 business rule 13: usable-launch confirmation re-evaluates
  // effective access fresh, before consuming funding/activating the session.
  const usableAccess = await evaluateAccessFresh({ learnerId: row.learner_id, appId: row.app_id,
    environment: row.deployment_environment, useCase: "usable_launch", now: input.now });
  if (!usableAccess.allowed || (usableAccess.state === "grace" &&
    !(row.source === "standard_monthly" || row.source === "technical_credit"))) {
    await releaseStartReservation(db, row, "entitlement_inactive", input.now);
    throw new LearnerSessionError("ENTITLEMENT_INACTIVE");
  }
  const usableLaunchEstablishedAt = input.now.toISOString();
  const hardExpiresAt = new Date(input.now.getTime() + 3600_000).toISOString();
  // jose signing is async, issued before the transaction starts.
  const sessionEnvelope = await issueSessionEnvelope({
    learner_session_id: row.id, learner_id: row.learner_id, app_id: row.app_id,
    environment: row.deployment_environment, deployment_id: row.deployment_id, release_id: row.release_id,
    device_session_id: row.device_session_id, usable_launch_established_at: usableLaunchEstablishedAt,
    hard_expires_at: hardExpiresAt, maximum_connected_seconds: row.maximum_connected_seconds,
  }, input.now);
  const { result, contributions } = await resolveDbClient().transaction(async (db) => {
    const updated = await db.run(
      `update learner_sessions set status='active',funding_state='consumed',
       usable_launch_established_at=?,active_segment_started_at=?,hard_expires_at=?,version=version+1,updated_at=?
       where id=? and status='starting' and version=?`,
      [usableLaunchEstablishedAt, usableLaunchEstablishedAt, hardExpiresAt, input.now.toISOString(), row.id, input.expectedSessionVersion]);
    if (updated.changes !== 1) throw new LearnerSessionError("LEARNER_SESSION_VERSION_CONFLICT");
    // PR-004 rule 33: a mandatory-progress app (one with a registered
    // progress schema for this release) may not reach usable launch while
    // its progress is unreadable or mutations are blocked — read_only_safe
    // still fails here too, since this flow is about to mutate progress
    // via the schema migration immediately below.
    if (await isMandatoryProgressApp(row.app_id, row.release_id!)) {
      const integrityGate = await validateProgressIntegrity({ learnerId: row.learner_id, appId: row.app_id,
        environment: row.deployment_environment!, reason: "launch", now: input.now });
      if (integrityGate.classification !== "healthy") throw new LearnerSessionError("PROGRESS_INTEGRITY_LAUNCH_BLOCKED");
    }
    // GAP-048/089: the app's provisional (usable-launch-only) grant is
    // upgraded to the full scope set in lockstep with the session itself
    // going active — never before this point.
    await activateAppGrant(context.grantId, input.now);
    // PR-001/GAP-092: the learner's stored progress is brought forward to
    // this release's declared schema version before any funding is
    // consumed — a missing migration path blocks the whole confirmation,
    // rolling back this transaction, rather than funding a session an app
    // can't actually read the learner's progress in.
    try {
      await migrateLearnerProgressToReleaseSchema({ appId: row.app_id, learnerId: row.learner_id, releaseId: row.release_id!,
        environment: row.deployment_environment!, now: input.now });
    } catch {
      throw new LearnerSessionError("PROGRESS_SCHEMA_MIGRATION_REQUIRED");
    }
    if (row.source === "standard_monthly" && row.standard_credit_batch_id) {
      await consumeStandardReservation(row.standard_credit_batch_id, row.learner_id, row.app_id, row.week_key, input.now);
    } else if (row.source === "technical_credit" && row.session_credit_id) {
      await consumeTechnicalCredit(row.session_credit_id, row.id, input.now);
    }
    const contributions = await contributeSessionRuntimeFor(db, row, `session-started:${row.id}`, input.now, {
      engagedSeconds: 0, sessionsStarted: 1, sessionsInterrupted: 0,
    });
    const response = { sessionId: row.id, status: "active", usableLaunchEstablishedAt, hardExpiresAt,
      maximumConnectedSeconds: row.maximum_connected_seconds, sessionEnvelope, sessionEnvelopeExpiresAt: hardExpiresAt };
    await db.run(
      `insert into usable_launch_requests(learner_session_id,app_principal_id,idempotency_key,request_hash,
       response_json,expires_at,created_at) values(?,?,?,?,?,?,?)`,
      [row.id, context.principalId, input.idempotencyKey, requestHash, JSON.stringify(response),
      new Date(input.now.getTime() + 7 * 86400_000).toISOString(), input.now.toISOString()]);
    await db.run(
      "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?, 'learner_session_usable_launch_confirmed',?)",
      [randomUUID(), row.parent_user_id, JSON.stringify({ sessionId: row.id, learnerId: row.learner_id,
      appId: row.app_id, runtimeInitializationId: input.runtimeInitializationId })]);
    return { result: response, contributions };
  });
  await applyContributions(contributions);
  // EG-002 rule 70 / SC-003 rule 60: the funded session commit is the
  // authority. Consistency is projected only after it commits, so a
  // projection failure can never roll back or delay a usable session. The
  // compact SC-002 usage row remains the reconciliation source of truth.
  if (row.source === "standard_monthly" && (row.weekly_session_ordinal ?? 0) <= 2) {
    try {
      await enqueueStandardSessionConsistency(row.id, input.now);
      await processQueuedStandardSessionConsistency(row.id, input.now);
    } catch {
      // Bounded EG-002 reconciliation/finalization repairs from SC-002.
    }
  }
  return result;
}

// SC-003 business rule 28: an explicit learner cancel before timeout shares
// the exact same release semantics as an expired-reservation sweep.
export async function cancelStartReservation(context: { learnerId: string; parentUserId: string }, sessionId: string,
  input: { expectedSessionVersion: number; now: Date }) {
  const db = resolveDbClient();
  const row = await sessionRow(db, sessionId);
  if (row.learner_id !== context.learnerId || row.parent_user_id !== context.parentUserId) {
    throw new LearnerSessionError("LEARNER_SESSION_BINDING_MISMATCH");
  }
  if (row.status === "cancelled_before_launch") return { sessionId: row.id, status: row.status };
  if (row.status !== "starting") throw new LearnerSessionError("SESSION_NOT_USABLE");
  if (row.version !== input.expectedSessionVersion) throw new LearnerSessionError("LEARNER_SESSION_VERSION_CONFLICT");
  await releaseStartReservation(db, row, "cancelled_by_learner", input.now);
  return { sessionId: row.id, status: "cancelled_before_launch" };
}

// SC-003 business rule 32: scheduled half of lazy+scheduled cleanup —
// correctness never depends on this running (startLearnerSession already
// self-heals a learner's own expired reservation), it just tidies up
// reservations abandoned without a retry.
export async function sweepExpiredStartReservations(now: Date): Promise<number> {
  const db = resolveDbClient();
  const timestamp = now.toISOString();
  const rows = await db.all<SessionRow>(
    "select * from learner_sessions where status='starting' and reservation_expires_at<=?",
    [timestamp]);
  for (const row of rows) await releaseStartReservation(db, row, "reservation_expired", now);
  return rows.length;
}

// Reported time is never trusted outright: it is capped by the session's
// maximum and by wall-clock time actually elapsed since usable launch, and
// can never move backwards (SC-001 business rule 19).
function acceptConnectedSeconds(row: SessionRow, reportedSeconds: number | undefined, now: Date) {
  const cap = row.maximum_connected_seconds;
  const reported = Math.max(0, Math.floor(reportedSeconds ?? 0));
  const wallClockCap = row.usable_launch_established_at
    ? Math.max(0, Math.floor((now.getTime() - new Date(row.usable_launch_established_at).getTime()) / 1000))
    : cap;
  const accepted = Math.min(reported, cap, wallClockCap);
  return Math.max(row.connected_elapsed_seconds, accepted);
}

export async function disconnectLearnerSession(context: AppProgressContext, input: {
  reportedConnectedSeconds?: number; now: Date;
}) {
  const outerDb = resolveDbClient();
  const row = await sessionRow(outerDb, context.learnerSessionId);
  assertContextBinding(row, context);
  if (row.status === "disconnected") return { sessionId: row.id, status: row.status, resumeDeadline: row.resume_deadline };
  if (row.status !== "active") throw new LearnerSessionError("SESSION_NOT_ACTIVE");
  const accepted = acceptConnectedSeconds(row, input.reportedConnectedSeconds, input.now);
  const reachedMax = accepted >= row.maximum_connected_seconds;
  const { contributions, ...outcome } = await resolveDbClient().transaction(async (db) => {
    if (reachedMax) {
      await db.run(
        "update learner_sessions set connected_elapsed_seconds=?,verified_active_seconds=?,active_segment_started_at=null,updated_at=? where id=?",
        [accepted, accepted, input.now.toISOString(), row.id]);
      const contributions = await contributeSessionRuntimeFor(db, row, `session-engaged-final:${row.id}`, input.now, {
        engagedSeconds: accepted - row.connected_elapsed_seconds, sessionsStarted: 0, sessionsInterrupted: 0,
      });
      return { reachedMax: true as const, contributions };
    }
    const remaining = 900 - row.cumulative_disconnected_seconds;
    const hardExpiresAtMs = row.hard_expires_at ? new Date(row.hard_expires_at).getTime() : Infinity;
    const deadline = new Date(Math.min(input.now.getTime() + remaining * 1000, hardExpiresAtMs)).toISOString();
    await db.run(
      `update learner_sessions set status='disconnected',disconnected_at=?,resume_deadline=?,
       connected_elapsed_seconds=?,verified_active_seconds=?,
       active_segment_started_at=null,interruption_episode_count=interruption_episode_count+1,version=version+1,updated_at=? where id=?`,
      [input.now.toISOString(), deadline, accepted, accepted, input.now.toISOString(), row.id]);
    const disconnected=await sessionRow(db, row.id);
    const contributions = await contributeSessionRuntimeFor(db, row, `session-disconnected:${row.id}:${disconnected.interruption_episode_count}`, input.now, {
      engagedSeconds: accepted - row.connected_elapsed_seconds, sessionsStarted: 0, sessionsInterrupted: 1,
    });
    // v45 removed automatic completion after repeated interruption (GAP-019/
    // 060/080) — hard expiry is the sole recovery boundary now, so a learner
    // can disconnect/resume any number of times as long as each resume lands
    // within its 15-minute window and before hard_expires_at.
    return { reachedMax: false as const, deadline, contributions };
  });
  await applyContributions(contributions);
  if (outcome.reachedMax) {
    // finalizeSessionAutomatically runs its own DbClient work and
    // re-validates the session's current status itself, so calling it
    // after commit here is safe even though the connected-seconds update
    // just committed separately.
    const finalized = await finalizeSessionAutomatically(row.id, "time_limit_reached", input.now);
    return { sessionId: row.id, status: finalized.status, resumeDeadline: null };
  }
  return { sessionId: row.id, status: "disconnected", resumeDeadline: outcome.deadline };
}

export async function resumeLearnerSession(context: AppProgressContext, input: {
  deviceSessionId: string; credential: string; now: Date;
}) {
  const db = resolveDbClient();
  const row = await sessionRow(db, context.learnerSessionId);
  assertContextBinding(row, context);
  if (input.deviceSessionId !== row.device_session_id) throw new LearnerSessionError("SESSION_RESUME_DEVICE_MISMATCH");
  const actualHash = createHash("sha256").update(input.credential).digest("hex");
  if (actualHash !== row.resume_token_hash) throw new LearnerSessionError("SESSION_RESUME_CREDENTIAL_INVALID");
  const intentionallyResumable = row.status === "resumable";
  if (!intentionallyResumable && (row.status !== "disconnected" || !row.disconnected_at || !row.resume_deadline)) {
    throw new LearnerSessionError("SESSION_NOT_RESUMABLE");
  }
  const hardExpired = row.hard_expires_at ? input.now >= new Date(row.hard_expires_at) : false;
  const disconnectedSeconds = intentionallyResumable ? 0 : Math.max(0, Math.floor(
    (input.now.getTime() - new Date(row.disconnected_at!).getTime()) / 1000,
  ));
  const cumulative = row.cumulative_disconnected_seconds + disconnectedSeconds;
  const interruptionWindowExpired = !intentionallyResumable &&
    (input.now > new Date(row.resume_deadline!) || cumulative > 900);
  if (hardExpired || interruptionWindowExpired) {
    await db.run(
      "update learner_sessions set status='interrupted',ended_at=?,end_reason=?,updated_at=? where id=?",
      [input.now.toISOString(), hardExpired ? "session_hard_expired" : "resume_window_expired",
      input.now.toISOString(), row.id]);
    await purgeLaunchDataForSession(row.id);
    await closeRecoveryWindow(row.id, hardExpired ? "hard_expired" : "irrecoverable", input.now);
    throw new LearnerSessionError(hardExpired ? "SESSION_HARD_EXPIRED" : "SESSION_RESUME_WINDOW_EXPIRED");
  }
  // GAP-101/EN-002 business rule 44: resume honors the entitlement binding
  // this session already started under, through its own hard expiry — not
  // a fresh live-covering-period check, which would wrongly deny resuming a
  // session whose paid period ended after it started.
  const resumeAccess = await evaluateAccessFresh({ learnerId: row.learner_id, appId: row.app_id,
    environment: row.deployment_environment ?? "production", useCase: "resume", now: input.now,
    boundEffectiveEntitlementId: row.effective_entitlement_id });
  if (!resumeAccess.allowed) throw new LearnerSessionError("ENTITLEMENT_INACTIVE");
  await db.run(
    `update learner_sessions set status='active',cumulative_disconnected_seconds=?,disconnected_at=null,
     resume_deadline=null,active_segment_started_at=?,intentional_exit_state='none',intentional_exit_reason=null,
     version=version+1,updated_at=? where id=?`,
    [cumulative, input.now.toISOString(), input.now.toISOString(), row.id]);
  const resumed = await sessionRow(db, row.id);
  // PR-002: amends resume with the current server-acknowledged progress and
  // whether/until-when the original browser may still submit a pending
  // local capsule through the recover-current endpoint — a live read of
  // learner_app_progress, matching how finalization already reads it,
  // rather than a persisted mirror ordinary checkpoints would need to keep
  // in sync.
  const progressRow = await db.get<{ progress_version: number; schema_version: number; state_hash: string | null }>(
    `select progress_version,schema_version,state_hash from learner_app_progress
    where learner_id=? and app_id=?`, [resumed.learner_id, resumed.app_id]);
  return { ...startResponse(resumed, input.now),
    currentProgressVersion: progressRow?.progress_version ?? 0,
    currentStateSchemaVersion: progressRow?.schema_version ?? null,
    currentStateHash: progressRow?.state_hash ?? null,
    recoveryAllowed: !!resumed.hard_expires_at && input.now < new Date(resumed.hard_expires_at),
    recoveryAllowedUntil: resumed.hard_expires_at };
}

export async function completeLearnerSession(sessionId: string, token: string, input: {
  deviceSessionId: string;
  now: Date;
}) {
  const db = resolveDbClient();
  const row = await sessionRow(db, sessionId);
  verifyToken(row, token, input.deviceSessionId, input.now);
  if (row.status === "completed") return finalSessionResponse(row);
  if (row.status !== "active") throw new LearnerSessionError("SESSION_NOT_ACTIVE");
  const timestamp = input.now.toISOString();
  const finalRow = await resolveDbClient().transaction(async (db) => {
    await db.run(
      `update learner_sessions set status='completed',ended_at=?,end_reason='app_completed',active_segment_started_at=null,
       version=version+1,updated_at=? where id=?`,
      [timestamp, timestamp, sessionId]);
    await purgeLaunchDataForSession(sessionId);
    await closeRecoveryWindow(sessionId, "secure_exit", input.now);
    await db.run(
      "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?, 'learner_session_completed',?)",
      [randomUUID(), row.parent_user_id, JSON.stringify({ sessionId, learnerId: row.learner_id,
      appId: row.app_id, connectedElapsedSeconds: row.connected_elapsed_seconds,
      verifiedActiveSeconds: row.verified_active_seconds })]);
    return (await db.get<SessionRow>("select * from learner_sessions where id=?", [sessionId]))!;
  });
  return finalSessionResponse(finalRow);
}

function finalSessionResponse(row: SessionRow) {
  return {
    sessionId: row.id,
    status: row.status,
    connectedElapsedSeconds: row.connected_elapsed_seconds,
    verifiedActiveSeconds: row.verified_active_seconds,
    conclusivelyUsed: row.verified_active_seconds >= 1350,
    weeklySlotNumber: row.weekly_slot_number,
    source: row.source,
  };
}

async function revokeSessionRows(db: DbClient, rows: SessionRow[], reason: string, now: Date): Promise<number> {
  const timestamp = now.toISOString();
  for (const row of rows) {
    if (row.status === "starting") {
      await releaseStartReservation(db, row, reason, now);
      continue;
    }
    await db.run(
      `update learner_sessions set status='revoked_by_admin',ended_at=?,end_reason=?,
       active_segment_started_at=null,disconnected_at=null,resume_deadline=null,resume_token_hash='',
       version=version+1,updated_at=? where id=?`,
      [timestamp, reason, timestamp, row.id]);
    await purgeLaunchDataForSession(row.id);
    await closeRecoveryWindow(row.id, "security_revoked", now);
    await db.run(
      "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?, 'learner_session_revoked',?)",
      [randomUUID(), row.parent_user_id, JSON.stringify({ sessionId: row.id,
      learnerId: row.learner_id, appId: row.app_id, reason })]);
  }
  return rows.length;
}

// GAP-010 (IA-003 soft delete, business rule 11): every learner session and
// app grant belonging to this parent must be revoked atomically as part of
// the same soft-delete transaction — not left to interrupt lazily on the
// next sweep, which would let an already-open session keep running.
export async function revokeActiveLearnerSessionsForParent(parentUserId: string, reason: string, now: Date): Promise<number> {
  const db = resolveDbClient();
  const rows = await db.all<SessionRow>(
    "select * from learner_sessions where parent_user_id=? and status in ('starting','active','disconnected','resumable')",
    [parentUserId]);
  return revokeSessionRows(db, rows, reason, now);
}

// EN-003 rule "preserve_to_hard_expiry": only the starting-reservation half
// of a terminal transition — active/resumable sessions are deliberately
// left alone so SC-001's existing hard_expires_at/sweepExpiredLearnerSessions/
// resumeLearnerSession machinery is what naturally ends them at their own
// boundary (rules 16/25/32/44).
export async function cancelStartingSessionsForLearnerApp(learnerId: string, appId: string, reason: string, now: Date): Promise<number> {
  const db = resolveDbClient();
  const rows = await db.all<SessionRow>(
    "select * from learner_sessions where learner_id=? and app_id=? and status='starting'",
    [learnerId, appId]);
  for (const row of rows) await releaseStartReservation(db, row, reason, now);
  return rows.length;
}

// EN-003 rule "immediate_revoke" (rules 45, 57): security/fraud events that
// must terminate an active/resumable session immediately, overriding the
// commercial-ending preserve-to-hard-expiry default.
export async function revokeActiveLearnerSessionsForLearnerApp(learnerId: string, appId: string, reason: string, now: Date): Promise<number> {
  const db = resolveDbClient();
  const rows = await db.all<SessionRow>(
    "select * from learner_sessions where learner_id=? and app_id=? and status in ('starting','active','disconnected','resumable')",
    [learnerId, appId]);
  return revokeSessionRows(db, rows, reason, now);
}

export async function sweepExpiredLearnerSessions(now: Date): Promise<number> {
  const db = resolveDbClient();
  const timestamp = now.toISOString();
  // SC-001 business rule 18: hard expiry finalizes lazily or by sweeper and
  // releases the lock — covers both a disconnected session past its resume
  // deadline and an active/disconnected session past its hard expiry (e.g.
  // the app vanished without ever sending a disconnect beacon).
  const rows = await db.all<SessionRow>(
    `select * from learner_sessions where
       (status='disconnected' and resume_deadline < ?)
       or (status in ('active','disconnected','resumable') and hard_expires_at is not null and hard_expires_at <= ?)`,
    [timestamp, timestamp]);
  if (!rows.length) return 0;
  const allContributions: ValidatedContribution[] = [];
  await resolveDbClient().transaction(async (db) => {
    for (const row of rows) {
      const hardExpired = row.hard_expires_at !== null && row.hard_expires_at <= timestamp;
      const reason = hardExpired ? "session_hard_expired" : "resume_window_expired";
      const interruptionCreatedBySweep = row.status === "active";
      await db.run(
        `update learner_sessions set status='interrupted',ended_at=?,end_reason=?,
         active_segment_started_at=null,interruption_episode_count=interruption_episode_count+?,version=version+1,updated_at=?
         where id=? and status in ('active','disconnected','resumable')`,
        [timestamp, reason, interruptionCreatedBySweep ? 1 : 0, timestamp, row.id]);
      if (interruptionCreatedBySweep) {
        allContributions.push(...await contributeSessionRuntimeFor(db, row, `session-swept-interruption:${row.id}`, now, {
          engagedSeconds: 0, sessionsStarted: 0, sessionsInterrupted: 1,
        }));
      }
      await purgeLaunchDataForSession(row.id);
      await closeRecoveryWindow(row.id, hardExpired ? "hard_expired" : "irrecoverable", now);
      await db.run(
        "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?, 'learner_session_interrupted',?)",
        [randomUUID(), row.parent_user_id, JSON.stringify({ sessionId: row.id,
        learnerId: row.learner_id, appId: row.app_id, reason,
        conclusivelyUsed: row.verified_active_seconds >= 1350 })]);
    }
  });
  await applyContributions(allContributions);
  return rows.length;
}
