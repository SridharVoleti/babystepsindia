import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { applyDailyContribution } from "@/lib/db/analytics-contribution-repo";
import { deriveAgeBand } from "@/lib/analytics/age-band";
import { kolkataCalendarDate } from "@/lib/analytics/kolkata-interval";
import { ProgressSchemaRegistryError, validateProgressSummary,
  type ProgressSummary } from "@/lib/progress-schema-registry/service";
import { computeCanonicalStateHash, validateProgressIntegrity } from "@/lib/progress-integrity/service";
import { parseDeploymentManifest, releaseSupportsMotivationType } from "@/lib/deployment-manifest/schema";
import { normalizeLessonJourneyDisplay, projectLessonOutbox } from "@/lib/journey/service";

export class AppProgressError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "AppProgressError"; }
}

export type AppProgressContext = {
  grantId: string; principalId: string; learnerSessionId: string; learnerId: string; appId: string;
};
export type CheckpointInput = {
  expectedProgressVersion: number; checkpointSequence: number; stateSchemaVersion: number;
  currentLevelKey: string; currentLessonKey: string; currentState: unknown; checkpointIdempotencyKey: string;
  // PR-003: optional standard app-owned progress summary — validated and
  // persisted alongside the checkpoint when the caller supplies one.
  progressSummary?: unknown;
};
export type WriteProgressSummaryInput = {
  basedOnProgressVersion: number;
  progressSummary: unknown;
  summaryIdempotencyKey: string;
};
type Session = { id: string; learner_id: string; app_id: string; status: string; release_id: string;
  verified_active_seconds: number; current_level_key: string | null; current_lesson_key: string | null;
  context_started_verified_seconds: number; parent_user_id: string; deployment_environment: string | null };

const MAX_STATE_BYTES = 64 * 1024;
const forbidden = /(^|_)(learner|parent|email|phone|address|password|token|credential|billing|answer|attempt|keystroke|click|history|analytics)($|_)/i;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown) => JSON.stringify(value);

function sessionFor(context: AppProgressContext) {
  const row = getDb().prepare("select * from learner_sessions where id=?").get(context.learnerSessionId) as Session | undefined;
  if(row?.status==="completed")throw new AppProgressError("LEARNER_SESSION_COMPLETED");
  if (!row || row.learner_id !== context.learnerId || row.app_id !== context.appId || !["active","disconnected"].includes(row.status))
    throw new AppProgressError("LEARNER_SESSION_NOT_ACTIVE");
  return row;
}

function validateContent(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(validateContent);
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    if (forbidden.test(key)) throw new AppProgressError("PROGRESS_STATE_PROHIBITED_CONTENT");
    validateContent(child);
  }
}

function matchesSchema(value: unknown, schema: Record<string, unknown>): boolean {
  const type = schema.type;
  if (type === "object") {
    if (!value || Array.isArray(value) || typeof value !== "object") return false;
    const object = value as Record<string, unknown>;
    if (Array.isArray(schema.required) && schema.required.some((key) => !(String(key) in object))) return false;
    const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>;
    if (schema.additionalProperties === false && Object.keys(object).some((key) => !properties[key])) return false;
    return Object.entries(properties).every(([key, child]) => !(key in object) || matchesSchema(object[key], child));
  }
  if (type === "array") return Array.isArray(value) && (!schema.items || value.every((item) => matchesSchema(item, schema.items as Record<string, unknown>)));
  if (type === "string") return typeof value === "string";
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}

// Exported (not just used internally) — PR-002's recovery write path
// reuses this exact schema/size/content validation rather than
// duplicating it (rule 29/34: recovery submits through "the same LA-003
// checkpoint validation ... domain").
export function validateState(releaseId: string, appId: string, schemaVersion: number, state: unknown) {
  const serialized = canonical(state);
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new AppProgressError("PROGRESS_STATE_TOO_LARGE");
  validateContent(state);
  const registered = getDb().prepare(`select schema_json,schema_digest from app_progress_schemas
    where app_id=? and release_id=? and schema_version=? and status='active'`)
    .get(appId,releaseId,schemaVersion) as { schema_json: string; schema_digest: string } | undefined;
  if (!registered || digest(registered.schema_json) !== registered.schema_digest)
    throw new AppProgressError("PROGRESS_SCHEMA_UNSUPPORTED");
  if (!matchesSchema(state,JSON.parse(registered.schema_json))) throw new AppProgressError("PROGRESS_STATE_INVALID");
  return { serialized };
}

// PR-004 rules 7-8: fail closed before any state-changing statement runs.
function assertMutationAllowed(session: Session, context: AppProgressContext, now: Date) {
  const gate = validateProgressIntegrity({ learnerId: context.learnerId, appId: context.appId,
    environment: session.deployment_environment ?? "production", reason: "write", now });
  if (gate.mutationBlocked) {
    throw new AppProgressError(gate.classification === "unreadable_corrupt"
      ? "PROGRESS_INTEGRITY_UNREADABLE" : "PROGRESS_INTEGRITY_MUTATION_BLOCKED");
  }
}

function responseRow(context: AppProgressContext) {
  const row = getDb().prepare("select * from learner_app_progress where learner_id=? and app_id=?")
    .get(context.learnerId,context.appId) as Record<string, unknown> | undefined;
  if (!row) return { exists: false, progressVersion: 0 };
  return { exists: true, progressVersion: row.progress_version, stateSchemaVersion: row.schema_version,
    currentLevelKey: row.current_level_key, currentLessonKey: row.current_lesson_key,
    currentState: JSON.parse(String(row.current_state_json ?? row.app_state ?? "null")),
    currentLessonEngagedSeconds: row.current_lesson_engaged_seconds,
    currentLevelEngagedSeconds: row.current_level_engaged_seconds, updatedAt: row.updated_at,
    progressSummary: row.progress_summary_json ? JSON.parse(String(row.progress_summary_json)) : null,
    progressSummaryVersion: row.progress_summary_version,
    progressSummaryStateHash: row.progress_summary_state_hash,
    progressSummaryBasedOnVersion: row.progress_summary_based_on_version };
}

export function getCurrentProgress(context: AppProgressContext) { sessionFor(context); return responseRow(context); }

function receipt(context: AppProgressContext, key: string, operation: string, requestHash: string) {
  const found = getDb().prepare(`select operation,request_hash,response_json from progress_mutation_requests
    where app_principal_id=? and grant_id=? and learner_session_id=? and idempotency_key=?`)
    .get(context.principalId,context.grantId,context.learnerSessionId,key) as
    { operation: string; request_hash: string; response_json: string } | undefined;
  if (!found) return undefined;
  if (found.operation !== operation || found.request_hash !== requestHash) throw new AppProgressError("IDEMPOTENCY_KEY_REUSED");
  return JSON.parse(found.response_json);
}

function assertVersionSequence(row: Record<string, unknown> | undefined, expected: number, sequence: number, sessionId: string) {
  const version = Number(row?.progress_version ?? 0);
  if (version !== expected) throw new AppProgressError("PROGRESS_VERSION_CONFLICT");
  if (row?.last_session_id === sessionId && sequence <= Number(row.last_checkpoint_sequence))
    throw new AppProgressError("PROGRESS_CHECKPOINT_OUT_OF_ORDER");
}

function validatedSummary(value: unknown): ProgressSummary {
  try { return validateProgressSummary(value); }
  catch (error) {
    if (error instanceof ProgressSchemaRegistryError) throw new AppProgressError(error.code);
    throw error;
  }
}

function assertReleaseSupportsSummary(session: Session, appId: string, summary: ProgressSummary) {
  if (!summary.motivationProgress) return;
  const release = getDb().prepare("select manifest_json from app_releases where id=? and app_id=?")
    .get(session.release_id, appId) as { manifest_json: string } | undefined;
  try {
    if (!release || !releaseSupportsMotivationType(parseDeploymentManifest(JSON.parse(release.manifest_json)),
      summary.motivationProgress.displayType)) throw new AppProgressError("PROGRESS_MOTIVATION_TYPE_UNSUPPORTED");
  } catch (error) {
    if (error instanceof AppProgressError) throw error;
    throw new AppProgressError("PROGRESS_MOTIVATION_TYPE_UNSUPPORTED");
  }
}

function summaryStateHash(context: AppProgressContext, session: Session, summary: ProgressSummary,
  basedOnProgressVersion: number, summaryVersion: number) {
  return digest(canonical({ learnerId: context.learnerId, appId: context.appId, releaseId: session.release_id,
    motivationContractVersion: summary.motivationProgress ? "1.0" : null, basedOnProgressVersion,
    summaryVersion, progressSummary: summary }));
}

export function writeProgressSummary(context: AppProgressContext, input: WriteProgressSummaryInput, now: Date) {
  const session = sessionFor(context); const db = getDb();
  assertMutationAllowed(session, context, now);
  if (!Number.isInteger(input.basedOnProgressVersion) || input.basedOnProgressVersion < 1 ||
      typeof input.summaryIdempotencyKey !== "string" || !input.summaryIdempotencyKey ||
      input.summaryIdempotencyKey.length > 200) throw new AppProgressError("PROGRESS_MOTIVATION_INVALID");
  const summary = validatedSummary(input.progressSummary);
  assertReleaseSupportsSummary(session, context.appId, summary);
  const requestHash = digest(canonical({ basedOnProgressVersion: input.basedOnProgressVersion,
    progressSummary: summary }));
  const replay = receipt(context, input.summaryIdempotencyKey, "summary_write", requestHash);
  if (replay) return replay;
  return db.transaction(() => {
    const row = db.prepare("select * from learner_app_progress where learner_id=? and app_id=?")
      .get(context.learnerId, context.appId) as Record<string, unknown> | undefined;
    if (!row || Number(row.progress_version) !== input.basedOnProgressVersion) {
      throw new AppProgressError("PROGRESS_VERSION_CONFLICT");
    }
    const summaryVersion = Number(row.progress_summary_version ?? 0) + 1;
    const summaryHash = summaryStateHash(context, session, summary, input.basedOnProgressVersion, summaryVersion);
    const timestamp = now.toISOString();
    db.prepare(`update learner_app_progress set progress_summary_json=?,progress_summary_visibility_status='current',
      progress_summary_based_on_version=?,progress_summary_version=?,progress_summary_state_hash=?,updated_at=?
      where learner_id=? and app_id=? and progress_version=?`)
      .run(JSON.stringify(summary), input.basedOnProgressVersion, summaryVersion, summaryHash, timestamp,
        context.learnerId, context.appId, input.basedOnProgressVersion);
    const result = responseRow(context);
    db.prepare(`insert into progress_mutation_requests(app_principal_id,grant_id,learner_session_id,idempotency_key,
      operation,request_hash,response_json,expires_at,created_at) values(?,?,?,?,'summary_write',?,?,?,?)`)
      .run(context.principalId, context.grantId, context.learnerSessionId, input.summaryIdempotencyKey, requestHash,
        JSON.stringify(result), new Date(now.getTime() + 3600_000).toISOString(), timestamp);
    db.prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'app_progress_summary_updated',?)")
      .run(randomUUID(), session.parent_user_id, JSON.stringify({ sessionId: session.id, appId: context.appId,
        progressVersion: input.basedOnProgressVersion, progressSummaryVersion: summaryVersion,
        motivationDisplayType: summary.motivationProgress?.displayType ?? null, summaryHash }));
    return result;
  })();
}

export function saveCheckpoint(context: AppProgressContext, input: CheckpointInput, now: Date) {
  const session = sessionFor(context); const db = getDb();
  assertMutationAllowed(session, context, now);
  const requestHash = digest(canonical(input));
  const replay = receipt(context,input.checkpointIdempotencyKey,"checkpoint",requestHash); if (replay) return replay;
  const checked = validateState(session.release_id,context.appId,input.stateSchemaVersion,input.currentState);
  const summary = input.progressSummary !== undefined ? validatedSummary(input.progressSummary) : undefined;
  if (summary) assertReleaseSupportsSummary(session, context.appId, summary);
  return db.transaction(() => {
    const row = db.prepare("select * from learner_app_progress where learner_id=? and app_id=?")
      .get(context.learnerId,context.appId) as Record<string, unknown> | undefined;
    assertVersionSequence(row,input.expectedProgressVersion,input.checkpointSequence,context.learnerSessionId);
    const nextVersion = Number(row?.progress_version ?? 0) + 1; const timestamp = now.toISOString();
    const stateHash = computeCanonicalStateHash({ learnerId: context.learnerId, appId: context.appId,
      environment: session.deployment_environment ?? "production", progressVersion: nextVersion,
      schemaVersion: input.stateSchemaVersion, serializedState: checked.serialized });
    // A freshly-supplied summary is current as of nextVersion; a carried-over
    // summary keeps its own prior based_on_version untouched (rules 17-19 —
    // PR-004's own validation is what later classifies it stale, not this
    // write path bumping it to look current when it isn't).
    const summaryJson = summary ? JSON.stringify(summary) : (row?.progress_summary_json as string | undefined) ?? null;
    const summaryVisibilityStatus = summary ? "current" : (row?.progress_summary_visibility_status as string | undefined) ?? "current";
    const summaryBasedOnVersion = summary ? nextVersion : (row?.progress_summary_based_on_version as number | null | undefined) ?? null;
    const summaryVersion = summary ? Number(row?.progress_summary_version ?? 0) + 1 : Number(row?.progress_summary_version ?? 0);
    const summaryHash = summary ? summaryStateHash(context, session, summary, nextVersion, summaryVersion) :
      (row?.progress_summary_state_hash as string | null | undefined) ?? null;
    db.prepare(`insert into learner_app_progress(learner_id,app_id,current_level_key,current_lesson_key,current_engaged_seconds,
      app_state,schema_version,current_state_json,current_lesson_engaged_seconds,current_level_engaged_seconds,progress_version,
      last_session_id,last_checkpoint_sequence,state_hash,progress_summary_json,progress_summary_visibility_status,
      progress_summary_based_on_version,progress_summary_version,progress_summary_state_hash,updated_at)
      values(?,?,?,?,0,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?)
      on conflict(learner_id,app_id) do update set current_level_key=excluded.current_level_key,
      current_lesson_key=excluded.current_lesson_key,app_state=excluded.app_state,schema_version=excluded.schema_version,
      current_state_json=excluded.current_state_json,progress_version=excluded.progress_version,last_session_id=excluded.last_session_id,
      last_checkpoint_sequence=excluded.last_checkpoint_sequence,state_hash=excluded.state_hash,
      progress_summary_json=excluded.progress_summary_json,progress_summary_visibility_status=excluded.progress_summary_visibility_status,
      progress_summary_based_on_version=excluded.progress_summary_based_on_version,
      progress_summary_version=excluded.progress_summary_version,progress_summary_state_hash=excluded.progress_summary_state_hash,
      updated_at=excluded.updated_at`)
      .run(context.learnerId,context.appId,input.currentLevelKey,input.currentLessonKey,checked.serialized,
        input.stateSchemaVersion,checked.serialized,Number(row?.current_lesson_engaged_seconds ?? 0),
        Number(row?.current_level_engaged_seconds ?? 0),nextVersion,context.learnerSessionId,input.checkpointSequence,stateHash,
        summaryJson,summaryVisibilityStatus,summaryBasedOnVersion,summaryVersion,summaryHash,timestamp);
    db.prepare(`update learner_sessions set current_level_key=?,current_lesson_key=?,context_started_verified_seconds=?,updated_at=? where id=?`)
      .run(input.currentLevelKey,input.currentLessonKey,session.verified_active_seconds,timestamp,session.id);
    const result = responseRow(context);
    db.prepare(`insert into progress_mutation_requests(app_principal_id,grant_id,learner_session_id,idempotency_key,
      operation,request_hash,response_json,expires_at,created_at) values(?,?,?,?,'checkpoint',?,?,?,?)`)
      .run(context.principalId,context.grantId,context.learnerSessionId,input.checkpointIdempotencyKey,requestHash,
        JSON.stringify(result),new Date(now.getTime()+3600_000).toISOString(),timestamp);
    db.prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'app_progress_checkpointed',?)")
      .run(randomUUID(),session.parent_user_id,JSON.stringify({ sessionId: session.id, appId: context.appId,
        progressVersion: nextVersion, checkpointSequence: input.checkpointSequence, stateHash }));
    return result;
  })();
}

export type CompleteLessonInput = Omit<CheckpointInput,"currentLevelKey"|"currentLessonKey"|"currentState"|"checkpointIdempotencyKey"> & {
  lessonKey: string; levelKey: string; nextLevelKey: string; nextLessonKey: string; nextState: unknown;
  completionOutcomeCode?: string; completionIdempotencyKey: string;
  journeyContractVersion?: string; journeyTitle?: string; journeyShortDescription?: string | null;
  journeyIconAssetKey?: string | null;
};

function tryProjectLessonCompletion(completionId: string, now: Date) {
  const outbox = getDb().prepare(`select id from lesson_journey_projection_outbox
    where completion_id=? order by created_at,id limit 1`).get(completionId) as { id: string } | undefined;
  if (!outbox) return;
  try { projectLessonOutbox(outbox.id, { markProcessed: false, now }); } catch { /* non-blocking EG-005 projection */ }
}

export function completeLesson(context: AppProgressContext, input: CompleteLessonInput, now: Date) {
  const session = sessionFor(context); const db = getDb();
  assertMutationAllowed(session, context, now);
  const requestHash = digest(canonical(input));
  const replay = receipt(context,input.completionIdempotencyKey,"lesson_complete",requestHash);
  if (replay) { tryProjectLessonCompletion(input.completionIdempotencyKey, now); return replay; }
  const existing = db.prepare("select * from lesson_completions where learner_id=? and app_id=? and lesson_key=?")
    .get(context.learnerId,context.appId,input.lessonKey) as Record<string, unknown> | undefined;
  if (existing) {
    tryProjectLessonCompletion(String(existing.completion_id), now);
    return { completion: completionView(existing), progress: responseRow(context), alreadyCompleted: true };
  }
  if (session.current_lesson_key !== input.lessonKey || session.current_level_key !== input.levelKey)
    throw new AppProgressError("LESSON_CONTEXT_MISMATCH");
  const checked = validateState(session.release_id,context.appId,input.stateSchemaVersion,input.nextState);
  const outcome = input.completionOutcomeCode ?? "completed";
  if (!/^[a-z0-9_-]{1,32}$/.test(outcome)) throw new AppProgressError("PROGRESS_STATE_INVALID");
  const summary = input.progressSummary !== undefined ? validatedSummary(input.progressSummary) : undefined;
  if (summary) assertReleaseSupportsSummary(session, context.appId, summary);
  let journeyDisplay: { title: string; shortDescription: string | null; iconAssetKey: string | null };
  try {
    journeyDisplay = normalizeLessonJourneyDisplay({ learnerId: context.learnerId, appId: context.appId,
      releaseId: session.release_id, environment: session.deployment_environment ?? "production" }, {
      journeyContractVersion: input.journeyContractVersion, title: input.journeyTitle,
      shortDescription: input.journeyShortDescription, iconAssetKey: input.journeyIconAssetKey,
    }, input.lessonKey);
  } catch {
    journeyDisplay = { title: input.lessonKey.slice(0, 100), shortDescription: null, iconAssetKey: null };
  }
  const committed = db.transaction(() => {
    const row = db.prepare("select * from learner_app_progress where learner_id=? and app_id=?")
      .get(context.learnerId,context.appId) as Record<string, unknown> | undefined;
    assertVersionSequence(row,input.expectedProgressVersion,input.checkpointSequence,context.learnerSessionId);
    const nextVersion=Number(row?.progress_version ?? 0)+1; const timestamp=now.toISOString();
    const stateHash = computeCanonicalStateHash({ learnerId: context.learnerId, appId: context.appId,
      environment: session.deployment_environment ?? "production", progressVersion: nextVersion,
      schemaVersion: input.stateSchemaVersion, serializedState: checked.serialized });
    const summaryJson = summary ? JSON.stringify(summary) : (row?.progress_summary_json as string | undefined) ?? null;
    const summaryVisibilityStatus = summary ? "current" : (row?.progress_summary_visibility_status as string | undefined) ?? "current";
    const summaryBasedOnVersion = summary ? nextVersion : (row?.progress_summary_based_on_version as number | null | undefined) ?? null;
    const summaryVersion = summary ? Number(row?.progress_summary_version ?? 0) + 1 : Number(row?.progress_summary_version ?? 0);
    const summaryHash = summary ? summaryStateHash(context, session, summary, nextVersion, summaryVersion) :
      (row?.progress_summary_state_hash as string | null | undefined) ?? null;
    const verified=Math.max(0,session.verified_active_seconds-session.context_started_verified_seconds)+Number(row?.current_lesson_engaged_seconds ?? 0);
    db.prepare(`insert into lesson_completions(learner_id,app_id,lesson_key,completion_id,level_key,completed_at,
      engaged_seconds,result,completion_outcome_code,progress_version_after_completion) values(?,?,?,?,?,?,?,?,?,?)`)
      .run(context.learnerId,context.appId,input.lessonKey,input.completionIdempotencyKey,input.levelKey,timestamp,
        verified,outcome,outcome,nextVersion);
    db.prepare(`update learner_app_progress set current_level_key=?,current_lesson_key=?,app_state=?,schema_version=?,
      current_state_json=?,current_lesson_engaged_seconds=0,current_level_engaged_seconds=case when current_level_key=? then current_level_engaged_seconds+? else 0 end,
      progress_version=?,last_session_id=?,last_checkpoint_sequence=?,state_hash=?,progress_summary_json=?,
      progress_summary_visibility_status=?,progress_summary_based_on_version=?,progress_summary_version=?,
      progress_summary_state_hash=?,updated_at=?
      where learner_id=? and app_id=?`)
      .run(input.nextLevelKey,input.nextLessonKey,checked.serialized,input.stateSchemaVersion,checked.serialized,input.nextLevelKey,
        verified,nextVersion,context.learnerSessionId,input.checkpointSequence,stateHash,summaryJson,
        summaryVisibilityStatus,summaryBasedOnVersion,summaryVersion,summaryHash,timestamp,
        context.learnerId,context.appId);
    db.prepare("update learner_sessions set current_level_key=?,current_lesson_key=?,context_started_verified_seconds=?,updated_at=? where id=?")
      .run(input.nextLevelKey,input.nextLessonKey,session.verified_active_seconds,timestamp,session.id);
    const completion=db.prepare("select * from lesson_completions where learner_id=? and app_id=? and lesson_key=?")
      .get(context.learnerId,context.appId,input.lessonKey) as Record<string, unknown>;
    const result={ completion: completionView(completion),progress: responseRow(context),alreadyCompleted:false };
    db.prepare(`insert into progress_mutation_requests(app_principal_id,grant_id,learner_session_id,idempotency_key,
      operation,request_hash,response_json,expires_at,created_at) values(?,?,?,?,'lesson_complete',?,?,?,?)`)
      .run(context.principalId,context.grantId,context.learnerSessionId,input.completionIdempotencyKey,requestHash,
        JSON.stringify(result),new Date(now.getTime()+3600_000).toISOString(),timestamp);
    const learner=db.prepare("select date_of_birth from learners where id=?").get(context.learnerId) as {date_of_birth:string};
    const activityDate=kolkataCalendarDate(now);
    applyDailyContribution({ contributionId:`lesson:${context.learnerId}:${context.appId}:${input.lessonKey}`,
      activityDate,learnerId:context.learnerId,appId:context.appId,levelKey:input.levelKey,
      ageBand:deriveAgeBand(learner.date_of_birth,activityDate),deltas:{engagedSeconds:0,sessionsStarted:0,
        sessionsCompleted:0,sessionsInterrupted:0,lessonsCompleted:1} });
    db.prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'app_lesson_completed',?)")
      .run(randomUUID(),session.parent_user_id,JSON.stringify({sessionId:session.id,appId:context.appId,
        lessonKey:input.lessonKey,progressVersion:nextVersion,stateHash}));
    const outboxId = randomUUID();
    const journeyStateHash = digest(canonical({ completionId: input.completionIdempotencyKey,
      learnerId: context.learnerId, appId: context.appId, releaseId: session.release_id,
      lessonKey: input.lessonKey, completedAt: timestamp, ...journeyDisplay }));
    db.prepare(`insert into lesson_journey_projection_outbox
      (id,completion_id,learner_id,app_id,release_id,lesson_key,completed_at,title_snapshot,
       short_description_snapshot,icon_asset_key,source_state_hash,status,created_at)
      values(?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(outboxId, input.completionIdempotencyKey,
        context.learnerId, context.appId, session.release_id, input.lessonKey, timestamp, journeyDisplay.title,
        journeyDisplay.shortDescription, journeyDisplay.iconAssetKey, journeyStateHash, timestamp);
    return { result, outboxId };
  })();
  try { projectLessonOutbox(committed.outboxId, { markProcessed: false, now }); } catch { /* completion stays committed */ }
  return committed.result;
}

function completionView(row: Record<string, unknown>) { return { lessonKey:row.lesson_key,levelKey:row.level_key,
  completedAt:row.completed_at,verifiedEngagedSeconds:row.engaged_seconds,outcomeCode:row.completion_outcome_code }; }

export function listCompletions(context: AppProgressContext, cursor?: string, limit=50) {
  sessionFor(context); const bounded=Math.max(1,Math.min(100,limit));
  const rows=getDb().prepare(`select * from lesson_completions where learner_id=? and app_id=? and lesson_key>?
    order by lesson_key limit ?`).all(context.learnerId,context.appId,cursor??"",bounded+1) as Record<string,unknown>[];
  return {items:rows.slice(0,bounded).map(completionView),nextCursor:rows.length>bounded?String(rows[bounded-1].lesson_key):null};
}

export function purgeProgressMutationReceipts(now: Date) {
  return getDb().prepare("delete from progress_mutation_requests where expires_at<=?").run(now.toISOString()).changes;
}
