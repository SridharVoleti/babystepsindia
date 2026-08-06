import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { isoWeekKey } from "@/lib/learning-session/week";
import { purgeLaunchDataForSession } from "@/lib/app-launch/service";
import { finalizeSessionAutomatically } from "@/lib/session-finalization/service";
import { reserveTechnicalCredit, restoreTechnicalCredit, consumeTechnicalCredit } from "@/lib/session-credit/service";
import { fundStandardSession, releaseStandardReservation, consumeStandardReservation } from "@/lib/session-credit-standard/service";
import { issueSessionEnvelope } from "@/lib/session-runtime/envelope";
import { evaluateAccessFresh } from "@/lib/entitlement-access/service";
import { applyDailyContribution } from "@/lib/db/analytics-contribution-repo";
import { deriveAgeBand } from "@/lib/analytics/age-band";
import { kolkataCalendarDate, splitKolkataEngagedSeconds } from "@/lib/analytics/kolkata-interval";
import type { AppProgressContext } from "@/lib/app-progress/service";

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
};

function contributeSessionRuntime(row: SessionRow, contributionId: string, now: Date, deltas: {
  engagedSeconds: number; sessionsStarted: number; sessionsInterrupted: number;
}) {
  const learner = getDb().prepare("select date_of_birth from learners where id=?").get(row.learner_id) as
    { date_of_birth: string } | undefined;
  if (!learner) throw new LearnerSessionError("LEARNER_NOT_FOUND");
  const common = { learnerId: row.learner_id, appId: row.app_id, levelKey: row.current_level_key ?? "unassigned" };
  const eventDate = kolkataCalendarDate(now);
  if (deltas.sessionsStarted > 0 || deltas.sessionsInterrupted > 0) {
    applyDailyContribution({ contributionId, activityDate: eventDate, ...common,
      ageBand: deriveAgeBand(learner.date_of_birth, eventDate), deltas: { engagedSeconds: 0,
        sessionsStarted: deltas.sessionsStarted, sessionsCompleted: 0,
        sessionsInterrupted: deltas.sessionsInterrupted, lessonsCompleted: 0 } });
  }
  if (deltas.engagedSeconds > 0) {
    const segmentStart = row.active_segment_started_at
      ? new Date(row.active_segment_started_at)
      : new Date(now.getTime() - deltas.engagedSeconds * 1000);
    for (const chunk of splitKolkataEngagedSeconds(segmentStart, deltas.engagedSeconds)) {
      applyDailyContribution({ contributionId: `${contributionId}:engaged:${chunk.activityDate}`,
        activityDate: chunk.activityDate, ...common, ageBand: deriveAgeBand(learner.date_of_birth, chunk.activityDate),
        deltas: { engagedSeconds: chunk.engagedSeconds, sessionsStarted: 0, sessionsCompleted: 0,
          sessionsInterrupted: 0, lessonsCompleted: 0 } });
    }
  }
}

function activeParent(parentUserId: string) {
  const row = getDb().prepare("select account_status from profiles where id=?").get(parentUserId) as
    | { account_status: string } | undefined;
  if (!row) throw new LearnerSessionError("PARENT_PROFILE_NOT_FOUND");
  if (row.account_status === "deleted") throw new LearnerSessionError("ACCOUNT_DELETED");
  if (row.account_status === "suspended") throw new LearnerSessionError("ACCOUNT_SUSPENDED");
}

function ownedLearners(parentUserId: string) {
  activeParent(parentUserId);
  return getDb().prepare(
    "select id, display_name displayName, avatar_id avatarId from learners where owner_parent_id=? order by created_at,id",
  ).all(parentUserId) as Array<{ id: string; displayName: string; avatarId: string | null }>;
}

export function getLearnerSelection(parentSessionId: string, parentUserId: string, expiresAt: string) {
  const learners = ownedLearners(parentUserId);
  const db = getDb();
  db.prepare("delete from learner_selection_contexts where expires_at <= ?").run(new Date().toISOString());
  let selected = db.prepare(
    "select selected_learner_id id from learner_selection_contexts where parent_session_id=? and parent_user_id=?",
  ).get(parentSessionId, parentUserId) as { id: string } | undefined;
  if (!selected && learners.length === 1) {
    selectLearner(parentSessionId, parentUserId, learners[0].id, expiresAt);
    selected = { id: learners[0].id };
  }
  return {
    learners,
    selectedLearnerId: selected?.id ?? null,
    requiresSelection: learners.length > 1 && !selected,
    requiresLearnerCreation: learners.length === 0,
  };
}

export function selectLearner(
  parentSessionId: string, parentUserId: string, learnerId: string, expiresAt: string,
) {
  activeParent(parentUserId);
  const owned = getDb().prepare("select 1 from learners where id=? and owner_parent_id=?")
    .get(learnerId, parentUserId);
  if (!owned) throw new LearnerSessionError("LEARNER_NOT_FOUND");
  const now = new Date().toISOString();
  getDb().prepare(
    `insert into learner_selection_contexts(parent_session_id,parent_user_id,selected_learner_id,selected_at,expires_at)
     values(?,?,?,?,?) on conflict(parent_session_id) do update set
     parent_user_id=excluded.parent_user_id,selected_learner_id=excluded.selected_learner_id,
     selected_at=excluded.selected_at,expires_at=excluded.expires_at`,
  ).run(parentSessionId, parentUserId, learnerId, now, expiresAt);
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
function releaseStartReservation(row: SessionRow, reason: string, now: Date) {
  const db = getDb();
  if (row.source === "standard_monthly" && row.standard_credit_batch_id) {
    releaseStandardReservation(row.standard_credit_batch_id, now);
  } else if (row.source === "technical_credit" && row.session_credit_id) {
    restoreTechnicalCredit(row.session_credit_id, row.id, now);
  }
  db.prepare(
    `update learner_sessions set status='cancelled_before_launch',funding_state='released',
     ended_at=?,end_reason=?,version=version+1,updated_at=? where id=? and status='starting'`,
  ).run(now.toISOString(), reason, now.toISOString(), row.id);
  purgeLaunchDataForSession(row.id);
  db.prepare(
    "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?, 'learner_session_start_cancelled',?)",
  ).run(randomUUID(), row.parent_user_id, JSON.stringify({ sessionId: row.id, learnerId: row.learner_id,
    appId: row.app_id, reason }));
}

export function startLearnerSession(input: StartInput) {
  activeParent(input.parentUserId);
  if (input.selectedLearnerId !== input.learnerId) throw new LearnerSessionError("LEARNER_SELECTION_MISMATCH");
  const db = getDb();
  const learner = db.prepare("select owner_parent_id,timezone from learners where id=?")
    .get(input.learnerId) as { owner_parent_id: string; timezone: string } | undefined;
  if (!learner || learner.owner_parent_id !== input.parentUserId) throw new LearnerSessionError("LEARNER_NOT_FOUND");
  // EN-002 business rule 11: Start re-evaluates effective access fresh,
  // before any credit reservation, rather than trusting a caller-supplied flag.
  const access = evaluateAccessFresh({ learnerId: input.learnerId, appId: input.appId,
    environment: input.deployment.environment, useCase: "start", now: input.now });
  if (!access.allowed) throw new LearnerSessionError("ENTITLEMENT_INACTIVE");
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
  const existing = db.prepare(
    "select request_hash,session_id,status from session_start_requests where actor_session_id=? and learner_id=? and idempotency_key=?",
  ).get(input.actorSessionId, input.learnerId, input.idempotencyKey) as
    | { request_hash: string; session_id: string; status: string } | undefined;
  if (existing) {
    if (existing.request_hash !== hash) throw new LearnerSessionError("IDEMPOTENCY_KEY_REUSED");
    const row = db.prepare("select * from learner_sessions where id=?").get(existing.session_id) as SessionRow;
    return startResponse(row, input.now);
  }

  const standardMonthly = input.fundingSource === "standard_monthly";
  const run = db.transaction(() => {
    // SC-003 business rule 32: lazy cleanup during starts — a learner's own
    // expired reservation is released here so a retry never has to wait for
    // the scheduled sweep.
    const reservedRow = db.prepare(
      "select * from learner_sessions where learner_id=? and status in ('starting','active','disconnected')",
    ).get(input.learnerId) as SessionRow | undefined;
    if (reservedRow) {
      const expired = reservedRow.status === "starting" && reservedRow.reservation_expires_at !== null &&
        reservedRow.reservation_expires_at <= input.now.toISOString();
      if (!expired) throw new LearnerSessionError("LEARNER_SESSION_IN_PROGRESS");
      releaseStartReservation(reservedRow, "reservation_expired", input.now);
    }
    const weekKey = isoWeekKey(input.now, learner.timezone);
    const timestamp = input.now.toISOString();
    const sessionId = randomUUID();
    let slot:number|null=null;
    let standardCreditBatchId:string|null=null;
    let weeklySessionOrdinal:number|null=null;
    if(technicalCredit){reserveTechnicalCredit(input.creditId!,input.learnerId,input.appId,sessionId,input.now);}
    else if(standardMonthly){
      const funded=fundStandardSession({learnerId:input.learnerId,appId:input.appId,timezone:learner.timezone,now:input.now});
      standardCreditBatchId=funded.batchId;weeklySessionOrdinal=funded.weeklySessionOrdinal;
    }
    else{
      db.prepare(`insert into learner_app_week_usage(learner_id,app_id,week_key,week_timezone,normal_sessions_started,updated_at)
       values(?,?,?,?,0,?) on conflict(learner_id,app_id,week_key) do nothing`).run(input.learnerId,input.appId,weekKey,learner.timezone,timestamp);
      const usage=db.prepare("select normal_sessions_started from learner_app_week_usage where learner_id=? and app_id=? and week_key=?")
       .get(input.learnerId,input.appId,weekKey) as {normal_sessions_started:number};
      if(usage.normal_sessions_started>=2)throw new LearnerSessionError("WEEKLY_SESSION_LIMIT_REACHED");slot=usage.normal_sessions_started+1;
    }
    const credential = resumeCredential(sessionId, input.deviceSessionId);
    db.prepare(
      `insert into session_start_requests(actor_session_id,learner_id,idempotency_key,request_hash,status,created_at)
       values(?,?,?,?, 'processing',?)`,
    ).run(input.actorSessionId, input.learnerId, input.idempotencyKey, hash, timestamp);
    if(!technicalCredit&&!standardMonthly)db.prepare(
      `update learner_app_week_usage set normal_sessions_started=?,version=version+1,updated_at=?
       where learner_id=? and app_id=? and week_key=?`,
    ).run(slot, timestamp, input.learnerId, input.appId, weekKey);
    const source=technicalCredit?"technical_credit":standardMonthly?"standard_monthly":"normal";
    const reservationExpiresAt=new Date(input.now.getTime()+300_000).toISOString();
    db.prepare(
      `insert into learner_sessions(id,learner_id,app_id,parent_user_id,parent_session_id,device_session_id,
       week_key,week_timezone,weekly_slot_number,source,session_credit_id,standard_credit_batch_id,weekly_session_ordinal,
       status,funding_state,reserved_at,reservation_expires_at,schedule_authorization_id,started_at,
       resume_token_hash,deployment_id,release_id,deployment_environment,deployment_origin,
       launch_path,session_expires_at,effective_entitlement_id,effective_entitlement_version_at_start,
       allocation_source_entitlement_period_id,created_at,updated_at)
       values(?,?,?,?,?,?,?,?,?,?,?,?,?,'starting','reserved',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(sessionId, input.learnerId, input.appId, input.parentUserId, input.actorSessionId,
      input.deviceSessionId, weekKey, learner.timezone, slot, source,
      technicalCredit?input.creditId:null, standardCreditBatchId, weeklySessionOrdinal,
      timestamp, reservationExpiresAt,
      technicalCredit?"technical-credit":input.scheduleAuthorizationId,
      timestamp, createHash("sha256").update(credential).digest("hex"),
      input.deployment.deploymentId, input.deployment.releaseId, input.deployment.environment,
      input.deployment.origin, input.deployment.launchPath,
      new Date(input.now.getTime() + 60 * 60_000).toISOString(),
      access.effectiveEntitlementId, access.effectiveEntitlementVersion, access.coveringPeriodId,
      timestamp, timestamp);
    db.prepare(
      `update session_start_requests set session_id=?,status='completed',completed_at=?
       where actor_session_id=? and learner_id=? and idempotency_key=?`,
    ).run(sessionId, timestamp, input.actorSessionId, input.learnerId, input.idempotencyKey);
    db.prepare(
      "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?, 'learner_session_started',?)",
    ).run(randomUUID(), input.parentUserId, JSON.stringify({ sessionId, learnerId: input.learnerId,
      appId: input.appId, weekKey, weeklySlotNumber: slot, weeklySessionOrdinal, fundingSource: source }));
    return db.prepare("select * from learner_sessions where id=?").get(sessionId) as SessionRow;
  });
  return startResponse(run(), input.now);
}

function sessionRow(sessionId: string): SessionRow {
  const row = getDb().prepare("select * from learner_sessions where id=?").get(sessionId) as SessionRow | undefined;
  if (!row) throw new LearnerSessionError("SESSION_NOT_FOUND");
  activeParent(row.parent_user_id);
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
export function establishUsableLaunch(sessionId: string, now: Date) {
  const db = getDb();
  const row = db.prepare(
    "select usable_launch_established_at,hard_expires_at,maximum_connected_seconds from learner_sessions where id=?",
  ).get(sessionId) as { usable_launch_established_at: string | null; hard_expires_at: string | null;
    maximum_connected_seconds: number } | undefined;
  if (!row) throw new LearnerSessionError("SESSION_NOT_FOUND");
  if (row.usable_launch_established_at && row.hard_expires_at) {
    return { usableLaunchEstablishedAt: row.usable_launch_established_at, hardExpiresAt: row.hard_expires_at,
      maximumConnectedSeconds: row.maximum_connected_seconds, alreadyEstablished: true };
  }
  const usableLaunchEstablishedAt = now.toISOString();
  const hardExpiresAt = new Date(now.getTime() + 3600_000).toISOString();
  db.prepare(
    "update learner_sessions set usable_launch_established_at=?,active_segment_started_at=?,hard_expires_at=?,updated_at=? where id=?",
  ).run(usableLaunchEstablishedAt, usableLaunchEstablishedAt, hardExpiresAt, usableLaunchEstablishedAt, sessionId);
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
  const db = getDb();
  // `now` is server-observed, not part of what makes two requests "the same
  // request" — excluded from the hash so a same-payload retry a moment
  // later is still recognized as identical (matches finalizeLearnerSession).
  const requestHash = createHash("sha256").update(JSON.stringify({ runtimeInitializationId: input.runtimeInitializationId,
    runtimeVersion: input.runtimeVersion, expectedSessionVersion: input.expectedSessionVersion })).digest("hex");
  const existingReceipt = db.prepare(
    `select request_hash,response_json from usable_launch_requests
     where learner_session_id=? and app_principal_id=? and idempotency_key=?`,
  ).get(context.learnerSessionId, context.principalId, input.idempotencyKey) as
    { request_hash: string; response_json: string } | undefined;
  if (existingReceipt) {
    if (existingReceipt.request_hash !== requestHash) throw new LearnerSessionError("IDEMPOTENCY_KEY_REUSED");
    return JSON.parse(existingReceipt.response_json);
  }
  const row = sessionRow(context.learnerSessionId);
  assertContextBinding(row, context);
  if (row.status === "active") throw new LearnerSessionError("USABLE_LAUNCH_ALREADY_CONFIRMED");
  if (row.status !== "starting") throw new LearnerSessionError("SESSION_NOT_USABLE");
  if (row.reservation_expires_at === null || row.reservation_expires_at <= input.now.toISOString()) {
    releaseStartReservation(row, "reservation_expired", input.now);
    throw new LearnerSessionError("SESSION_START_RESERVATION_EXPIRED");
  }
  if (row.version !== input.expectedSessionVersion) throw new LearnerSessionError("LEARNER_SESSION_VERSION_CONFLICT");
  if (!row.deployment_id || !row.release_id || !row.deployment_environment) {
    throw new LearnerSessionError("USABLE_LAUNCH_CONTEXT_MISMATCH");
  }
  // EN-002 business rule 13: usable-launch confirmation re-evaluates
  // effective access fresh, before consuming funding/activating the session.
  const usableAccess = evaluateAccessFresh({ learnerId: row.learner_id, appId: row.app_id,
    environment: row.deployment_environment, useCase: "usable_launch", now: input.now });
  if (!usableAccess.allowed) {
    releaseStartReservation(row, "entitlement_inactive", input.now);
    throw new LearnerSessionError("ENTITLEMENT_INACTIVE");
  }
  const usableLaunchEstablishedAt = input.now.toISOString();
  const hardExpiresAt = new Date(input.now.getTime() + 3600_000).toISOString();
  // jose signing is async; better-sqlite3 transactions must be synchronous
  // (same reason app-launch/service.ts signs its bootstrap assertion first).
  const sessionEnvelope = await issueSessionEnvelope({
    learner_session_id: row.id, learner_id: row.learner_id, app_id: row.app_id,
    environment: row.deployment_environment, deployment_id: row.deployment_id, release_id: row.release_id,
    device_session_id: row.device_session_id, usable_launch_established_at: usableLaunchEstablishedAt,
    hard_expires_at: hardExpiresAt, maximum_connected_seconds: row.maximum_connected_seconds,
  }, input.now);
  return db.transaction(() => {
    const updated = db.prepare(
      `update learner_sessions set status='active',funding_state='consumed',
       usable_launch_established_at=?,active_segment_started_at=?,hard_expires_at=?,version=version+1,updated_at=?
       where id=? and status='starting' and version=?`,
    ).run(usableLaunchEstablishedAt, usableLaunchEstablishedAt, hardExpiresAt, input.now.toISOString(), row.id, input.expectedSessionVersion);
    if (updated.changes !== 1) throw new LearnerSessionError("LEARNER_SESSION_VERSION_CONFLICT");
    if (row.source === "standard_monthly" && row.standard_credit_batch_id) {
      consumeStandardReservation(row.standard_credit_batch_id, row.learner_id, row.app_id, row.week_key, input.now);
    } else if (row.source === "technical_credit" && row.session_credit_id) {
      consumeTechnicalCredit(row.session_credit_id, row.id, input.now);
    }
    contributeSessionRuntime(row, `session-started:${row.id}`, input.now, {
      engagedSeconds: 0, sessionsStarted: 1, sessionsInterrupted: 0,
    });
    const response = { sessionId: row.id, status: "active", usableLaunchEstablishedAt, hardExpiresAt,
      maximumConnectedSeconds: row.maximum_connected_seconds, sessionEnvelope, sessionEnvelopeExpiresAt: hardExpiresAt };
    db.prepare(
      `insert into usable_launch_requests(learner_session_id,app_principal_id,idempotency_key,request_hash,
       response_json,expires_at,created_at) values(?,?,?,?,?,?,?)`,
    ).run(row.id, context.principalId, input.idempotencyKey, requestHash, JSON.stringify(response),
      new Date(input.now.getTime() + 7 * 86400_000).toISOString(), input.now.toISOString());
    db.prepare(
      "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?, 'learner_session_usable_launch_confirmed',?)",
    ).run(randomUUID(), row.parent_user_id, JSON.stringify({ sessionId: row.id, learnerId: row.learner_id,
      appId: row.app_id, runtimeInitializationId: input.runtimeInitializationId }));
    return response;
  })();
}

// SC-003 business rule 28: an explicit learner cancel before timeout shares
// the exact same release semantics as an expired-reservation sweep.
export function cancelStartReservation(context: { learnerId: string; parentUserId: string }, sessionId: string,
  input: { expectedSessionVersion: number; now: Date }) {
  const row = sessionRow(sessionId);
  if (row.learner_id !== context.learnerId || row.parent_user_id !== context.parentUserId) {
    throw new LearnerSessionError("LEARNER_SESSION_BINDING_MISMATCH");
  }
  if (row.status === "cancelled_before_launch") return { sessionId: row.id, status: row.status };
  if (row.status !== "starting") throw new LearnerSessionError("SESSION_NOT_USABLE");
  if (row.version !== input.expectedSessionVersion) throw new LearnerSessionError("LEARNER_SESSION_VERSION_CONFLICT");
  releaseStartReservation(row, "cancelled_by_learner", input.now);
  return { sessionId: row.id, status: "cancelled_before_launch" };
}

// SC-003 business rule 32: scheduled half of lazy+scheduled cleanup —
// correctness never depends on this running (startLearnerSession already
// self-heals a learner's own expired reservation), it just tidies up
// reservations abandoned without a retry.
export function sweepExpiredStartReservations(now: Date): number {
  const timestamp = now.toISOString();
  const rows = getDb().prepare(
    "select * from learner_sessions where status='starting' and reservation_expires_at<=?",
  ).all(timestamp) as SessionRow[];
  for (const row of rows) releaseStartReservation(row, "reservation_expired", now);
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

export function disconnectLearnerSession(context: AppProgressContext, input: {
  reportedConnectedSeconds?: number; now: Date;
}) {
  const row = sessionRow(context.learnerSessionId);
  assertContextBinding(row, context);
  if (row.status === "disconnected") return { sessionId: row.id, status: row.status, resumeDeadline: row.resume_deadline };
  if (row.status !== "active") throw new LearnerSessionError("SESSION_NOT_ACTIVE");
  const accepted = acceptConnectedSeconds(row, input.reportedConnectedSeconds, input.now);
  return getDb().transaction(() => {
    if (accepted >= row.maximum_connected_seconds) {
      getDb().prepare(
        "update learner_sessions set connected_elapsed_seconds=?,verified_active_seconds=?,active_segment_started_at=null,updated_at=? where id=?",
      ).run(accepted, accepted, input.now.toISOString(), row.id);
      contributeSessionRuntime(row, `session-engaged-final:${row.id}`, input.now, {
        engagedSeconds: accepted - row.connected_elapsed_seconds, sessionsStarted: 0, sessionsInterrupted: 0,
      });
      const finalized = finalizeSessionAutomatically(row.id, "time_limit_reached", input.now);
      return { sessionId: row.id, status: finalized.status, resumeDeadline: null };
    }
    const remaining = 900 - row.cumulative_disconnected_seconds;
    const hardExpiresAtMs = row.hard_expires_at ? new Date(row.hard_expires_at).getTime() : Infinity;
    const deadline = new Date(Math.min(input.now.getTime() + remaining * 1000, hardExpiresAtMs)).toISOString();
    getDb().prepare(
      `update learner_sessions set status='disconnected',disconnected_at=?,resume_deadline=?,
       connected_elapsed_seconds=?,verified_active_seconds=?,
       active_segment_started_at=null,interruption_episode_count=interruption_episode_count+1,version=version+1,updated_at=? where id=?`,
    ).run(input.now.toISOString(), deadline, accepted, accepted, input.now.toISOString(), row.id);
    const disconnected=sessionRow(row.id);
    contributeSessionRuntime(row, `session-disconnected:${row.id}:${disconnected.interruption_episode_count}`, input.now, {
      engagedSeconds: accepted - row.connected_elapsed_seconds, sessionsStarted: 0, sessionsInterrupted: 1,
    });
    if(disconnected.interruption_episode_count>=3&&disconnected.connected_elapsed_seconds>2025){
      const finalized=finalizeSessionAutomatically(row.id,"repeated_interruption_after_threshold",input.now);
      return {sessionId:row.id,status:finalized.status,resumeDeadline:null};
    }
    return { sessionId: row.id, status: "disconnected", resumeDeadline: deadline };
  })();
}

export function resumeLearnerSession(context: AppProgressContext, input: {
  deviceSessionId: string; credential: string; now: Date;
}) {
  const row = sessionRow(context.learnerSessionId);
  assertContextBinding(row, context);
  if (input.deviceSessionId !== row.device_session_id) throw new LearnerSessionError("SESSION_RESUME_DEVICE_MISMATCH");
  const actualHash = createHash("sha256").update(input.credential).digest("hex");
  if (actualHash !== row.resume_token_hash) throw new LearnerSessionError("SESSION_RESUME_CREDENTIAL_INVALID");
  if (row.status !== "disconnected" || !row.disconnected_at || !row.resume_deadline) {
    throw new LearnerSessionError("SESSION_NOT_RESUMABLE");
  }
  const hardExpired = row.hard_expires_at ? input.now >= new Date(row.hard_expires_at) : false;
  const disconnectedSeconds = Math.max(0, Math.floor(
    (input.now.getTime() - new Date(row.disconnected_at).getTime()) / 1000,
  ));
  const cumulative = row.cumulative_disconnected_seconds + disconnectedSeconds;
  if (hardExpired || input.now > new Date(row.resume_deadline) || cumulative > 900) {
    getDb().prepare(
      "update learner_sessions set status='interrupted',ended_at=?,end_reason=?,updated_at=? where id=?",
    ).run(input.now.toISOString(), hardExpired ? "session_hard_expired" : "resume_window_expired",
      input.now.toISOString(), row.id);
    purgeLaunchDataForSession(row.id);
    throw new LearnerSessionError(hardExpired ? "SESSION_HARD_EXPIRED" : "SESSION_RESUME_WINDOW_EXPIRED");
  }
  getDb().prepare(
    `update learner_sessions set status='active',cumulative_disconnected_seconds=?,disconnected_at=null,
     resume_deadline=null,active_segment_started_at=?,version=version+1,updated_at=? where id=?`,
  ).run(cumulative, input.now.toISOString(), input.now.toISOString(), row.id);
  return startResponse(sessionRow(row.id), input.now);
}

export function completeLearnerSession(sessionId: string, token: string, input: {
  deviceSessionId: string;
  now: Date;
}) {
  const row = sessionRow(sessionId);
  verifyToken(row, token, input.deviceSessionId, input.now);
  if (row.status === "completed") return finalSessionResponse(row);
  if (row.status !== "active") throw new LearnerSessionError("SESSION_NOT_ACTIVE");
  const timestamp = input.now.toISOString();
  const run = getDb().transaction(() => {
    getDb().prepare(
      `update learner_sessions set status='completed',ended_at=?,end_reason='app_completed',active_segment_started_at=null,
       version=version+1,updated_at=? where id=?`,
    ).run(timestamp, timestamp, sessionId);
    purgeLaunchDataForSession(sessionId);
    getDb().prepare(
      "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?, 'learner_session_completed',?)",
    ).run(randomUUID(), row.parent_user_id, JSON.stringify({ sessionId, learnerId: row.learner_id,
      appId: row.app_id, connectedElapsedSeconds: row.connected_elapsed_seconds,
      verifiedActiveSeconds: row.verified_active_seconds }));
    return getDb().prepare("select * from learner_sessions where id=?").get(sessionId) as SessionRow;
  });
  return finalSessionResponse(run());
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

export function sweepExpiredLearnerSessions(now: Date): number {
  const timestamp = now.toISOString();
  // SC-001 business rule 18: hard expiry finalizes lazily or by sweeper and
  // releases the lock — covers both a disconnected session past its resume
  // deadline and an active/disconnected session past its hard expiry (e.g.
  // the app vanished without ever sending a disconnect beacon).
  const rows = getDb().prepare(
    `select * from learner_sessions where
       (status='disconnected' and resume_deadline < ?)
       or (status in ('active','disconnected') and hard_expires_at is not null and hard_expires_at <= ?)`,
  ).all(timestamp, timestamp) as SessionRow[];
  if (!rows.length) return 0;
  const run = getDb().transaction(() => {
    for (const row of rows) {
      const hardExpired = row.hard_expires_at !== null && row.hard_expires_at <= timestamp;
      const reason = hardExpired ? "session_hard_expired" : "resume_window_expired";
      const interruptionCreatedBySweep = row.status === "active";
      getDb().prepare(
        `update learner_sessions set status='interrupted',ended_at=?,end_reason=?,
         active_segment_started_at=null,interruption_episode_count=interruption_episode_count+?,version=version+1,updated_at=?
         where id=? and status in ('active','disconnected')`,
      ).run(timestamp, reason, interruptionCreatedBySweep ? 1 : 0, timestamp, row.id);
      if (interruptionCreatedBySweep) {
        contributeSessionRuntime(row, `session-swept-interruption:${row.id}`, now, {
          engagedSeconds: 0, sessionsStarted: 0, sessionsInterrupted: 1,
        });
      }
      purgeLaunchDataForSession(row.id);
      getDb().prepare(
        "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?, 'learner_session_interrupted',?)",
      ).run(randomUUID(), row.parent_user_id, JSON.stringify({ sessionId: row.id,
        learnerId: row.learner_id, appId: row.app_id, reason,
        conclusivelyUsed: row.verified_active_seconds >= 1350 }));
    }
  });
  run();
  return rows.length;
}
