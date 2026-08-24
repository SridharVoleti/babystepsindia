import { createHash, randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { findGraceCoverage } from "@/lib/billing/grace-policy";
import { currentIsoWeekBounds, isoWeekBounds } from "@/lib/learning-session/week";

export const CONSISTENCY_TARGET = 2 as const;
export type ConsistencyWeekStatus = "open" | "cadence_complete" | "incomplete_reset" |
  "neutral_partial" | "platform_unavailable_neutral" | "out_of_scope";

export class ConsistencyError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ConsistencyError"; }
}

type StateRow = {
  learner_id: string; app_id: string; environment: string; current_streak_weeks: number;
  longest_streak_weeks: number; current_week_key: string; current_week_progress: number;
  current_week_start_at: string; current_week_end_at: string; latest_completed_week_key: string | null;
  last_computed_usage_version: number; state_version: number; state_hash: string; updated_at: string;
};
type WeekRow = {
  learner_id: string; app_id: string; environment: string; weekly_key: string; week_timezone: string;
  weekly_start_at: string; weekly_end_at: string; cadence_target: number; qualifying_standard_sessions: number;
  status: ConsistencyWeekStatus; entitlement_opening_state: OpeningFacts["state"];
  entitlement_opening_reference: string | null; availability_neutral_evidence: string | null;
  cadence_completed_by_session_id: string | null; completed_at: string | null; finalized_at: string | null;
  result_version: number; result_hash: string; updated_at: string;
};
type ReceiptRow = { request_hash: string; status: string; result_json: string | null };
type OpeningFacts = { state: "eligible" | "approved_grace" | "partial_start" | "out_of_scope";
  reference: string | null; hasMidweekEnd: boolean };

export type ConsistencyCurrentView = {
  appId: string; appKey: string; appName: string; currentStreakWeeks: number; longestStreakWeeks: number;
  currentWeekProgress: 0 | 1 | 2; target: 2; currentWeekKey: string; currentWeekStartAt: string;
  currentWeekEndAt: string; status: ConsistencyWeekStatus; stateVersion: number;
};
export type ConsistencyHistoryView = {
  appId: string; appName: string; weeklyKey: string; weeklyStartAt: string; weeklyEndAt: string;
  qualifyingStandardSessions: number; target: 2; status: Exclude<ConsistencyWeekStatus, "open">;
  completedAt: string | null;
};
export type FinalizeConsistencyResult = { completed: number; reset: number; neutral: number;
  outOfScope: number; nextCursor: string | null };
export type ReconcileConsistencyResult = { healthy: number; repaired: number; conflict: number;
  error: number; nextCursor: string | null };

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertEnvironment(value: string) {
  if (!["development", "staging", "production"].includes(value)) throw new ConsistencyError("CONSISTENCY_ENVIRONMENT_INVALID");
}

function assertLimit(value: number | undefined, fallback = 20) {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ConsistencyError("CONSISTENCY_PAGE_INVALID");
  return limit;
}

// Reads profiles.timezone directly rather than going through learner-repo's
// getParentTimezone (now async, and account-status validation isn't
// meaningful for this internal calendar-week-bucketing lookup).
async function learnerTimezone(db: DbClient, learnerId: string) {
  const learner = await db.get<{ owner_parent_id: string }>("select owner_parent_id from learners where id=?", [learnerId]);
  if (!learner) throw new ConsistencyError("CONSISTENCY_RESOURCE_NOT_FOUND");
  const profile = await db.get<{ timezone: string }>("select timezone from profiles where id=?", [learner.owner_parent_id]);
  if (!profile) throw new ConsistencyError("CONSISTENCY_RESOURCE_NOT_FOUND");
  return profile.timezone;
}

async function usage(db: DbClient, learnerId: string, appId: string, weeklyKey: string) {
  return (await db.get<{ standard_sessions_funded: number; version: number; week_timezone: string }>(
    `select standard_sessions_funded,version,week_timezone from learner_app_week_usage
    where learner_id=? and app_id=? and week_key=?`, [learnerId, appId, weeklyKey])) ??
    { standard_sessions_funded: 0, version: 0, week_timezone: await learnerTimezone(db, learnerId) };
}

async function stateRow(db: DbClient, learnerId: string, appId: string, environment: string) {
  return db.get<StateRow>(`select * from learner_app_consistency where learner_id=? and app_id=? and environment=?`,
    [learnerId, appId, environment]);
}

async function weekRow(db: DbClient, learnerId: string, appId: string, environment: string, weeklyKey: string) {
  return db.get<WeekRow>(`select * from learner_app_consistency_weeks
    where learner_id=? and app_id=? and environment=? and weekly_key=?`,
    [learnerId, appId, environment, weeklyKey]);
}

async function appSnapshot(db: DbClient, appId: string) {
  const app = await db.get<{ app_key: string; display_name: string }>(
    "select app_key,display_name from app_registry where id=?", [appId]);
  if (!app) throw new ConsistencyError("CONSISTENCY_RESOURCE_NOT_FOUND");
  return app;
}

async function openingFacts(db: DbClient, learnerId: string, appId: string, startAt: Date, endAt: Date): Promise<OpeningFacts> {
  const opening = await db.get<{ id: string; period_end: string }>(`select id,period_end from learner_app_entitlement_periods
    where learner_id=? and app_id=? and period_start<=? and period_end>?
    order by period_end desc,id limit 1`, [learnerId, appId, startAt.toISOString(), startAt.toISOString()]);
  if (opening) {
    const continuing = await db.get<{ period_end: string | null }>(`select max(period_end) period_end from learner_app_entitlement_periods
      where learner_id=? and app_id=? and period_start<? and period_end>?`,
      [learnerId, appId, endAt.toISOString(), startAt.toISOString()]);
    return { state: "eligible", reference: opening.id,
      hasMidweekEnd: !continuing?.period_end || continuing.period_end < endAt.toISOString() };
  }
  const grace = await findGraceCoverage({ learnerId, appId, now: startAt });
  if (grace) return { state: "approved_grace", reference: grace.entitlementPeriodId,
    hasMidweekEnd: grace.graceEndsAt < endAt.toISOString() };
  const partial = await db.get<{ id: string }>(`select id from learner_app_entitlement_periods
    where learner_id=? and app_id=? and period_start>? and period_start<? and period_end>?
    order by period_start,id limit 1`, [learnerId, appId, startAt.toISOString(), endAt.toISOString(), startAt.toISOString()]);
  return partial ? { state: "partial_start", reference: partial.id, hasMidweekEnd: false }
    : { state: "out_of_scope", reference: null, hasMidweekEnd: false };
}

function weekResultHash(value: Omit<WeekRow, "result_hash" | "updated_at" | "result_version">) {
  return digest(value);
}

async function ensureWeek(db: DbClient, input: { learnerId: string; appId: string; environment: string; weeklyKey: string;
  timezone: string; now: Date }) {
  const existing = await weekRow(db, input.learnerId, input.appId, input.environment, input.weeklyKey);
  if (existing) return existing;
  const bounds = isoWeekBounds(input.weeklyKey, input.timezone);
  const opening = await openingFacts(db, input.learnerId, input.appId, bounds.startAt, bounds.endAt);
  const base = {
    learner_id: input.learnerId, app_id: input.appId, environment: input.environment, weekly_key: input.weeklyKey,
    week_timezone: input.timezone, weekly_start_at: bounds.startAt.toISOString(), weekly_end_at: bounds.endAt.toISOString(),
    cadence_target: CONSISTENCY_TARGET, qualifying_standard_sessions: 0, status: "open" as const,
    entitlement_opening_state: opening.state, entitlement_opening_reference: opening.reference,
    availability_neutral_evidence: null, cadence_completed_by_session_id: null, completed_at: null, finalized_at: null,
  };
  await db.run(`insert into learner_app_consistency_weeks
    (learner_id,app_id,environment,weekly_key,week_timezone,weekly_start_at,weekly_end_at,cadence_target,
     qualifying_standard_sessions,status,entitlement_opening_state,entitlement_opening_reference,
     availability_neutral_evidence,cadence_completed_by_session_id,completed_at,finalized_at,result_version,
     result_hash,created_at,updated_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
    [base.learner_id, base.app_id, base.environment, base.weekly_key, base.week_timezone,
      base.weekly_start_at, base.weekly_end_at, base.cadence_target, base.qualifying_standard_sessions,
      base.status, base.entitlement_opening_state, base.entitlement_opening_reference,
      base.availability_neutral_evidence, base.cadence_completed_by_session_id, base.completed_at,
      base.finalized_at, weekResultHash(base), input.now.toISOString(), input.now.toISOString()]);
  return (await weekRow(db, input.learnerId, input.appId, input.environment, input.weeklyKey))!;
}

function stateHash(input: { learnerId: string; appId: string; environment: string; currentStreakWeeks: number;
  longestStreakWeeks: number; currentWeekKey: string; currentWeekProgress: number;
  latestCompletedWeekKey: string | null; lastComputedUsageVersion: number }) {
  return digest(input);
}

async function writeState(db: DbClient, input: { learnerId: string; appId: string; environment: string; currentStreakWeeks: number;
  longestStreakWeeks: number; currentWeekKey: string; currentWeekProgress: number;
  latestCompletedWeekKey: string | null; lastComputedUsageVersion: number; timezone: string; now: Date }) {
  const bounds = isoWeekBounds(input.currentWeekKey, input.timezone);
  const hash = stateHash(input);
  await db.run(`insert into learner_app_consistency
    (learner_id,app_id,environment,current_streak_weeks,longest_streak_weeks,current_week_key,
     current_week_progress,current_week_start_at,current_week_end_at,latest_completed_week_key,
     last_computed_usage_version,state_version,state_hash,created_at,updated_at)
    values(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)
    on conflict(learner_id,app_id,environment) do update set
      current_streak_weeks=excluded.current_streak_weeks,longest_streak_weeks=excluded.longest_streak_weeks,
      current_week_key=excluded.current_week_key,current_week_progress=excluded.current_week_progress,
      current_week_start_at=excluded.current_week_start_at,current_week_end_at=excluded.current_week_end_at,
      latest_completed_week_key=excluded.latest_completed_week_key,
      last_computed_usage_version=excluded.last_computed_usage_version,
      state_version=case when learner_app_consistency.state_hash=excluded.state_hash then learner_app_consistency.state_version
        else learner_app_consistency.state_version+1 end,state_hash=excluded.state_hash,updated_at=excluded.updated_at`,
    [input.learnerId, input.appId, input.environment, input.currentStreakWeeks, input.longestStreakWeeks,
      input.currentWeekKey, Math.min(2, input.currentWeekProgress), bounds.startAt.toISOString(), bounds.endAt.toISOString(),
      input.latestCompletedWeekKey, input.lastComputedUsageVersion, hash, input.now.toISOString(), input.now.toISOString()]);
  return (await stateRow(db, input.learnerId, input.appId, input.environment))!;
}

async function hasCommercialGapAfter(db: DbClient, learnerId: string, appId: string, latestCompletedWeekKey: string | null,
  currentWeekKey: string, timezone: string) {
  if (!latestCompletedWeekKey || latestCompletedWeekKey >= currentWeekKey) return false;
  const from = isoWeekBounds(latestCompletedWeekKey, timezone).endAt.toISOString();
  const to = isoWeekBounds(currentWeekKey, timezone).startAt.toISOString();
  if (from >= to) return false;
  const periods = await db.all<{ period_start: string; period_end: string }>(`select period_start,period_end from learner_app_entitlement_periods
    where learner_id=? and app_id=? and period_end>? and period_start<? order by period_start,period_end`,
    [learnerId, appId, from, to]);
  let coveredUntil = from;
  for (const period of periods) {
    if (period.period_start > coveredUntil) return true;
    if (period.period_end > coveredUntil) coveredUntil = period.period_end;
    if (coveredUntil >= to) return false;
  }
  return coveredUntil < to;
}

async function completedSessionId(db: DbClient, learnerId: string, appId: string, weeklyKey: string) {
  const rows = await db.all<{ id: string }>(`select id from learner_sessions where learner_id=? and app_id=? and week_key=?
    and source='standard_monthly' and weekly_session_ordinal<=2 and usable_launch_established_at is not null
    order by usable_launch_established_at,id limit 2`, [learnerId, appId, weeklyKey]);
  return rows[1]?.id ?? null;
}

async function completeWeek(db: DbClient, input: { learnerId: string; appId: string; environment: string; weeklyKey: string;
  timezone: string; qualifyingCount: number; usageVersion: number; sessionId: string | null; now: Date }) {
  const week = await ensureWeek(db, input);
  if (week.status === "cadence_complete") return (await stateRow(db, input.learnerId, input.appId, input.environment))!;
  const partial = week.entitlement_opening_state === "partial_start" || week.entitlement_opening_state === "out_of_scope";
  const status: ConsistencyWeekStatus = partial ? "neutral_partial" : "cadence_complete";
  const count = Math.min(2, input.qualifyingCount);
  const result = { ...week, qualifying_standard_sessions: count, status,
    cadence_completed_by_session_id: status === "cadence_complete" ? input.sessionId : null,
    completed_at: status === "cadence_complete" ? input.now.toISOString() : null,
    finalized_at: status === "cadence_complete" ? input.now.toISOString() : null };
  await db.run(`update learner_app_consistency_weeks set qualifying_standard_sessions=?,status=?,
    cadence_completed_by_session_id=?,completed_at=?,finalized_at=?,result_version=result_version+1,result_hash=?,updated_at=?
    where learner_id=? and app_id=? and environment=? and weekly_key=?`,
    [count, status, result.cadence_completed_by_session_id, result.completed_at, result.finalized_at,
      weekResultHash(result), input.now.toISOString(), input.learnerId, input.appId, input.environment, input.weeklyKey]);
  const current = await stateRow(db, input.learnerId, input.appId, input.environment);
  let streak = current?.current_streak_weeks ?? 0;
  let longest = current?.longest_streak_weeks ?? 0;
  let latest = current?.latest_completed_week_key ?? null;
  if (status === "cadence_complete") {
    if (await hasCommercialGapAfter(db, input.learnerId, input.appId, latest, input.weeklyKey, input.timezone)) streak = 0;
    streak += 1; longest = Math.max(longest, streak); latest = input.weeklyKey;
  }
  return writeState(db, { learnerId: input.learnerId, appId: input.appId, environment: input.environment,
    currentStreakWeeks: streak, longestStreakWeeks: longest, currentWeekKey: input.weeklyKey,
    currentWeekProgress: count, latestCompletedWeekKey: latest, lastComputedUsageVersion: input.usageVersion,
    timezone: input.timezone, now: input.now });
}

function mergeBlockedMilliseconds(windows: { starts_at: string; ends_at: string; id: string }[], start: Date, end: Date) {
  const intervals = windows.map((window) => [Math.max(start.getTime(), new Date(window.starts_at).getTime()),
    Math.min(end.getTime(), new Date(window.ends_at).getTime())] as const).filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  let total = 0; let from = -1; let to = -1;
  for (const interval of intervals) {
    if (interval[0] > to) { if (to > from) total += to - from; [from, to] = interval; }
    else to = Math.max(to, interval[1]);
  }
  if (to > from) total += to - from;
  return total;
}

async function platformNeutralEvidence(db: DbClient, appId: string, environment: string, start: Date, end: Date) {
  const current = await db.get<{ operational_state: string; updated_at: string; expected_return_at: string | null }>(
    `select operational_state,updated_at,expected_return_at from app_launch_availability
    where app_id=? and environment=?`, [appId, environment]);
  if (current && current.operational_state !== "available" && current.updated_at <= start.toISOString()
    && (!current.expected_return_at || current.expected_return_at >= end.toISOString())) {
    return digest({ kind: "durable_app_unavailable", state: current.operational_state, updatedAt: current.updated_at });
  }
  const windows = await db.all<{ id: string; starts_at: string; ends_at: string }>(
    `select id,starts_at,ends_at from app_maintenance_windows where app_id=? and environment=?
    and status<>'cancelled' and starts_at<? and ends_at>? order by starts_at,id`,
    [appId, environment, end.toISOString(), start.toISOString()]);
  const availableMs = end.getTime() - start.getTime() - mergeBlockedMilliseconds(windows, start, end);
  return availableMs < 2 * 3_900_000 && windows.length > 0
    ? digest({ kind: "maintenance_windows", ids: windows.map((window) => window.id) }) : null;
}

async function finalizeOne(db: DbClient, input: { learnerId: string; appId: string; environment: string; weeklyKey: string;
  timezone: string; now: Date }) {
  const week = await ensureWeek(db, input);
  if (week.status !== "open") return week.status;
  const source = await usage(db, input.learnerId, input.appId, input.weeklyKey);
  if (source.standard_sessions_funded >= 2) {
    const sessionId = await completedSessionId(db, input.learnerId, input.appId, input.weeklyKey);
    if (!sessionId) throw new ConsistencyError("CONSISTENCY_SOURCE_CONFLICT");
    await completeWeek(db, { ...input, qualifyingCount: source.standard_sessions_funded,
      usageVersion: source.version, sessionId });
    return (await weekRow(db, input.learnerId, input.appId, input.environment, input.weeklyKey))!.status;
  }
  const bounds = isoWeekBounds(input.weeklyKey, input.timezone);
  const opening = await openingFacts(db, input.learnerId, input.appId, bounds.startAt, bounds.endAt);
  const evidence = opening.state === "eligible" || opening.state === "approved_grace"
    ? await platformNeutralEvidence(db, input.appId, input.environment, bounds.startAt, bounds.endAt) : null;
  const status: ConsistencyWeekStatus = opening.state === "partial_start" || opening.hasMidweekEnd ? "neutral_partial"
    : opening.state === "out_of_scope" ? "out_of_scope"
    : evidence ? "platform_unavailable_neutral" : "incomplete_reset";
  const result = { ...week, qualifying_standard_sessions: Math.min(2, source.standard_sessions_funded), status,
    entitlement_opening_state: opening.state, entitlement_opening_reference: opening.reference,
    availability_neutral_evidence: evidence, finalized_at: input.now.toISOString() };
  await db.run(`update learner_app_consistency_weeks set qualifying_standard_sessions=?,status=?,
    entitlement_opening_state=?,entitlement_opening_reference=?,availability_neutral_evidence=?,finalized_at=?,
    result_version=result_version+1,result_hash=?,updated_at=? where learner_id=? and app_id=? and environment=? and weekly_key=?`,
    [result.qualifying_standard_sessions, status, opening.state, opening.reference, evidence,
      input.now.toISOString(), weekResultHash(result), input.now.toISOString(), input.learnerId, input.appId,
      input.environment, input.weeklyKey]);
  const current = await stateRow(db, input.learnerId, input.appId, input.environment);
  if (status === "incomplete_reset" && (!current || current.current_week_key <= input.weeklyKey)) {
    await writeState(db, { learnerId: input.learnerId, appId: input.appId, environment: input.environment,
      currentStreakWeeks: 0, longestStreakWeeks: current?.longest_streak_weeks ?? 0,
      currentWeekKey: input.weeklyKey, currentWeekProgress: result.qualifying_standard_sessions,
      latestCompletedWeekKey: current?.latest_completed_week_key ?? null, lastComputedUsageVersion: source.version,
      timezone: input.timezone, now: input.now });
  }
  return status;
}

async function beginOrReadReceipt(db: DbClient, input: { action: "standard_session_committed" | "finalize_week" | "reconcile";
  eventId: string; requestHash: string; learnerId?: string | null; appId?: string | null; environment: string;
  weeklyKey?: string | null; sourceSessionId?: string | null; sourceUsageVersion?: number | null;
  runIdempotencyKey?: string | null; cursor?: string | null; principalId: string; now: Date }) {
  const existing = await db.get<ReceiptRow>(`select request_hash,status,result_json from consistency_mutation_receipts
    where action=? and event_id=?`, [input.action, input.eventId]);
  if (existing) {
    if (existing.request_hash !== input.requestHash) throw new ConsistencyError("IDEMPOTENCY_KEY_REUSED");
    if (existing.status === "completed" && existing.result_json) return JSON.parse(existing.result_json) as unknown;
    return null;
  }
  await db.run(`insert into consistency_mutation_receipts
    (id,learner_id,app_id,environment,weekly_key,action,source_session_id,source_usage_version,event_id,
     run_idempotency_key,cursor,request_hash,status,principal_id,attempt_count,created_at,updated_at)
    values(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,0,?,?)`,
    [randomUUID(), input.learnerId ?? null, input.appId ?? null, input.environment, input.weeklyKey ?? null,
      input.action, input.sourceSessionId ?? null, input.sourceUsageVersion ?? null, input.eventId,
      input.runIdempotencyKey ?? null, input.cursor ?? "", input.requestHash, input.principalId,
      input.now.toISOString(), input.now.toISOString()]);
  return null;
}

async function completeReceipt(db: DbClient, action: string, eventId: string, result: unknown, now: Date) {
  await db.run(`update consistency_mutation_receipts set status='completed',result_json=?,
    attempt_count=attempt_count+1,updated_at=?,completed_at=? where action=? and event_id=?`,
    [JSON.stringify(result), now.toISOString(), now.toISOString(), action, eventId]);
}

export async function enqueueStandardSessionConsistency(sourceSessionId: string, now: Date) {
  const db = resolveDbClient();
  const session = await db.get<{ id: string; learner_id: string; app_id: string;
      deployment_environment: string | null; week_key: string; weekly_session_ordinal: number | null; source: string }>(
    `select id,learner_id,app_id,deployment_environment,week_key,weekly_session_ordinal,source
    from learner_sessions where id=?`, [sourceSessionId]);
  if (!session || session.source !== "standard_monthly" || !session.weekly_session_ordinal || session.weekly_session_ordinal > 2) return null;
  const source = await usage(db, session.learner_id, session.app_id, session.week_key);
  const eventId = `standard-session:${sourceSessionId}`;
  const requestHash = digest({ sourceSessionId, weeklyUsageVersion: source.version, eventId });
  await beginOrReadReceipt(db, { action: "standard_session_committed", eventId, requestHash, learnerId: session.learner_id,
    appId: session.app_id, environment: session.deployment_environment ?? "production", weeklyKey: session.week_key,
    sourceSessionId, sourceUsageVersion: source.version, principalId: "sc003-session-domain", now });
  return { eventId, weeklyUsageVersion: source.version };
}

export async function applyStandardSessionConsistency(input: { sourceSessionId: string; weeklyUsageVersion: number;
  eventId: string; principalId: string; now: Date }) {
  const db = resolveDbClient();
  const session = await db.get<{ id: string; learner_id: string; app_id: string; deployment_environment: string | null;
      week_key: string; week_timezone: string; weekly_session_ordinal: number | null; source: string;
      usable_launch_established_at: string | null }>(`select id,learner_id,app_id,deployment_environment,week_key,week_timezone,
    weekly_session_ordinal,source,usable_launch_established_at from learner_sessions where id=?`,
    [input.sourceSessionId]);
  if (!session) throw new ConsistencyError("CONSISTENCY_SOURCE_NOT_FOUND");
  if (session.source !== "standard_monthly" || !session.usable_launch_established_at || !session.weekly_session_ordinal
    || session.weekly_session_ordinal > 2) throw new ConsistencyError("CONSISTENCY_SOURCE_NOT_QUALIFYING");
  if (input.eventId !== `standard-session:${session.id}`) throw new ConsistencyError("CONSISTENCY_SOURCE_CONFLICT");
  const environment = session.deployment_environment ?? "production";
  const requestHash = digest({ sourceSessionId: input.sourceSessionId, weeklyUsageVersion: input.weeklyUsageVersion,
    eventId: input.eventId });
  const existingReceipt = await db.get<ReceiptRow>(`select request_hash,status,result_json from consistency_mutation_receipts
    where action='standard_session_committed' and event_id=?`, [input.eventId]);
  if (existingReceipt) {
    if (existingReceipt.request_hash !== requestHash) throw new ConsistencyError("IDEMPOTENCY_KEY_REUSED");
    if (existingReceipt.status === "completed" && existingReceipt.result_json) {
      return JSON.parse(existingReceipt.result_json) as ConsistencyCurrentView;
    }
  }
  const source = await usage(db, session.learner_id, session.app_id, session.week_key);
  if (source.version !== input.weeklyUsageVersion) throw new ConsistencyError("CONSISTENCY_USAGE_VERSION_CONFLICT");
  return resolveDbClient().transaction(async (db) => {
    const cached = await beginOrReadReceipt(db, { action: "standard_session_committed", eventId: input.eventId, requestHash,
      learnerId: session.learner_id, appId: session.app_id, environment, weeklyKey: session.week_key,
      sourceSessionId: session.id, sourceUsageVersion: source.version, principalId: input.principalId, now: input.now });
    if (cached) return cached as ConsistencyCurrentView;
    const current = await stateRow(db, session.learner_id, session.app_id, environment);
    if (current && current.current_week_key < session.week_key) {
      await finalizeOne(db, { learnerId: session.learner_id, appId: session.app_id, environment,
        weeklyKey: current.current_week_key, timezone: session.week_timezone, now: input.now });
    }
    const count = Math.min(CONSISTENCY_TARGET, source.standard_sessions_funded);
    if (count >= 2) {
      await completeWeek(db, { learnerId: session.learner_id, appId: session.app_id, environment,
        weeklyKey: session.week_key, timezone: session.week_timezone, qualifyingCount: count,
        usageVersion: source.version,
        sessionId: (await completedSessionId(db, session.learner_id, session.app_id, session.week_key)) ?? session.id,
        now: input.now });
    } else {
      await ensureWeek(db, { learnerId: session.learner_id, appId: session.app_id, environment,
        weeklyKey: session.week_key, timezone: session.week_timezone, now: input.now });
      const refreshed = await stateRow(db, session.learner_id, session.app_id, environment);
      await writeState(db, { learnerId: session.learner_id, appId: session.app_id, environment,
        currentStreakWeeks: refreshed?.current_streak_weeks ?? 0, longestStreakWeeks: refreshed?.longest_streak_weeks ?? 0,
        currentWeekKey: session.week_key, currentWeekProgress: count,
        latestCompletedWeekKey: refreshed?.latest_completed_week_key ?? null,
        lastComputedUsageVersion: source.version, timezone: session.week_timezone, now: input.now });
      const week = (await weekRow(db, session.learner_id, session.app_id, environment, session.week_key))!;
      await db.run(`update learner_app_consistency_weeks set qualifying_standard_sessions=?,
        result_version=result_version+1,result_hash=?,updated_at=? where learner_id=? and app_id=? and environment=? and weekly_key=?`,
        [count, digest({ ...week, qualifying_standard_sessions: count }), input.now.toISOString(),
          session.learner_id, session.app_id, environment, session.week_key]);
    }
    const result = await readCurrentConsistency(session.learner_id, session.app_id, environment, input.now);
    await completeReceipt(db, "standard_session_committed", input.eventId, result, input.now);
    return result;
  });
}

export async function processQueuedStandardSessionConsistency(sourceSessionId: string, now: Date) {
  const receipt = await resolveDbClient().get<{ event_id: string; source_usage_version: number; principal_id: string }>(
    `select event_id,source_usage_version,principal_id from consistency_mutation_receipts
    where action='standard_session_committed' and source_session_id=? order by created_at desc limit 1`, [sourceSessionId]);
  if (!receipt) return null;
  return applyStandardSessionConsistency({ sourceSessionId, weeklyUsageVersion: receipt.source_usage_version,
    eventId: receipt.event_id, principalId: receipt.principal_id, now });
}

export async function readCurrentConsistency(learnerId: string, appId: string, environment = "production", now = new Date()): Promise<ConsistencyCurrentView> {
  assertEnvironment(environment);
  const db = resolveDbClient();
  const timezone = await learnerTimezone(db, learnerId);
  const bounds = currentIsoWeekBounds(now, timezone);
  const source = await usage(db, learnerId, appId, bounds.weeklyKey);
  const state = await stateRow(db, learnerId, appId, environment);
  const week = await weekRow(db, learnerId, appId, environment, bounds.weeklyKey);
  const app = await appSnapshot(db, appId);
  const progress = Math.min(2, Math.max(state?.current_week_key === bounds.weeklyKey ? state.current_week_progress : 0,
    source.standard_sessions_funded)) as 0 | 1 | 2;
  return { appId, appKey: app.app_key, appName: app.display_name,
    currentStreakWeeks: state?.current_streak_weeks ?? 0, longestStreakWeeks: state?.longest_streak_weeks ?? 0,
    currentWeekProgress: progress, target: CONSISTENCY_TARGET, currentWeekKey: bounds.weeklyKey,
    currentWeekStartAt: bounds.startAt.toISOString(), currentWeekEndAt: bounds.endAt.toISOString(),
    status: week?.status ?? "open", stateVersion: state?.state_version ?? 0 };
}

function encodeCursor(value: unknown) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function decodeCursor(value: string | null | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed.some((part) => typeof part !== "string")) throw new Error();
    return parsed as [string, string, string];
  } catch { throw new ConsistencyError("CONSISTENCY_CURSOR_INVALID"); }
}

export async function listConsistency(input: { learnerId: string; environment?: string; appId?: string | null;
  cursor?: string | null; limit?: number; now?: Date }) {
  const environment = input.environment ?? "production"; assertEnvironment(environment);
  const now = input.now ?? new Date(); const limit = assertLimit(input.limit); const cursor = decodeCursor(input.cursor);
  const db = resolveDbClient();
  const params: (string | number)[] = [input.learnerId, environment];
  let appFilter = "";
  if (input.appId) { appFilter = " and app_id=?"; params.push(input.appId); }
  const appIds = new Set<string>();
  for (const row of await db.all<{ app_id: string }>(`select app_id from learner_app_consistency where learner_id=? and environment=?${appFilter}`,
    params)) appIds.add(row.app_id);
  const entitlementParams: (string | number)[] = [input.learnerId, environment];
  if (input.appId) entitlementParams.push(input.appId);
  for (const row of await db.all<{ app_id: string }>(`select app_id from learner_app_effective_entitlements
    where learner_id=? and environment=?${appFilter}`, entitlementParams)) appIds.add(row.app_id);
  const apps = [];
  for (const appId of appIds) apps.push(await readCurrentConsistency(input.learnerId, appId, environment, now));
  apps.sort((a, b) => a.appName.localeCompare(b.appName) || a.appId.localeCompare(b.appId));

  const where = ["w.learner_id=?", "w.environment=?", "w.status<>'open'"];
  const historyParams: (string | number)[] = [input.learnerId, environment];
  if (input.appId) { where.push("w.app_id=?"); historyParams.push(input.appId); }
  if (cursor) {
    where.push("(w.weekly_start_at<? or (w.weekly_start_at=? and w.app_id>?) or (w.weekly_start_at=? and w.app_id=? and w.weekly_key<?))");
    historyParams.push(cursor[0], cursor[0], cursor[1], cursor[0], cursor[1], cursor[2]);
  }
  historyParams.push(limit + 1);
  const rows = await db.all<WeekRow & { app_name: string }>(`select w.*,a.display_name app_name from learner_app_consistency_weeks w
    join app_registry a on a.id=w.app_id where ${where.join(" and ")}
    order by w.weekly_start_at desc,w.app_id,w.weekly_key desc limit ?`, historyParams);
  const page = rows.slice(0, limit);
  const history: ConsistencyHistoryView[] = page.map((row) => ({ appId: row.app_id, appName: row.app_name,
    weeklyKey: row.weekly_key, weeklyStartAt: row.weekly_start_at, weeklyEndAt: row.weekly_end_at,
    qualifyingStandardSessions: row.qualifying_standard_sessions, target: CONSISTENCY_TARGET,
    status: row.status as Exclude<ConsistencyWeekStatus, "open">, completedAt: row.completed_at }));
  const last = page.at(-1);
  return { apps, history, nextCursor: rows.length > limit && last
    ? encodeCursor([last.weekly_start_at, last.app_id, last.weekly_key]) : null };
}

async function candidatePairs(db: DbClient, weeklyKey: string, environment: string) {
  const pairs = new Map<string, { learnerId: string; appId: string; timezone: string }>();
  const add = async (learnerId: string, appId: string, timezone?: string) => {
    const key = `${learnerId} ${appId}`;
    if (!pairs.has(key)) pairs.set(key, { learnerId, appId, timezone: timezone ?? await learnerTimezone(db, learnerId) });
  };
  for (const row of await db.all<{ learner_id: string; app_id: string; week_timezone: string }>(
    `select learner_id,app_id,week_timezone from learner_app_week_usage where week_key=?`, [weeklyKey]))
    await add(row.learner_id, row.app_id, row.week_timezone);
  for (const row of await db.all<{ learner_id: string; app_id: string }>(`select learner_id,app_id from learner_app_consistency_weeks
    where environment=? and weekly_key=?`, [environment, weeklyKey])) await add(row.learner_id, row.app_id);
  for (const row of await db.all<{ learner_id: string; app_id: string }>(`select learner_id,app_id from learner_app_effective_entitlements where environment=?`,
    [environment])) {
    const timezone = await learnerTimezone(db, row.learner_id); const bounds = isoWeekBounds(weeklyKey, timezone);
    const overlap = await db.get(`select 1 as x from learner_app_entitlement_periods where learner_id=? and app_id=?
      and period_start<? and period_end>? limit 1`, [row.learner_id, row.app_id,
      bounds.endAt.toISOString(), bounds.startAt.toISOString()]);
    if (overlap) await add(row.learner_id, row.app_id, timezone);
  }
  return [...pairs.values()].sort((a, b) => a.learnerId.localeCompare(b.learnerId) || a.appId.localeCompare(b.appId));
}

export async function finalizeConsistencyWeek(input: { weeklyKey: string; environment?: string; cursor?: string | null;
  limit: number; runIdempotencyKey: string; principalId: string; now?: Date }): Promise<FinalizeConsistencyResult> {
  const environment = input.environment ?? "production"; assertEnvironment(environment);
  const now = input.now ?? new Date(); const limit = assertLimit(input.limit, 100);
  try { isoWeekBounds(input.weeklyKey, "Asia/Kolkata"); } catch { throw new ConsistencyError("CONSISTENCY_WEEK_INVALID"); }
  if (!input.runIdempotencyKey || input.runIdempotencyKey.length > 160) throw new ConsistencyError("IDEMPOTENCY_KEY_REUSED");
  const cursor = input.cursor ?? "";
  const eventId = `finalize:${environment}:${input.weeklyKey}:${input.runIdempotencyKey}:${cursor}`;
  const requestHash = digest({ weeklyKey: input.weeklyKey, environment, cursor, limit });
  return resolveDbClient().transaction(async (db) => {
    const cached = await beginOrReadReceipt(db, { action: "finalize_week", eventId, requestHash, environment,
      weeklyKey: input.weeklyKey, runIdempotencyKey: input.runIdempotencyKey, cursor,
      principalId: input.principalId, now });
    if (cached) return cached as FinalizeConsistencyResult;
    const all = await candidatePairs(db, input.weeklyKey, environment);
    const eligible = cursor ? all.filter((pair) => `${pair.learnerId} ${pair.appId}` > cursor) : all;
    const page = eligible.slice(0, limit); const counts = { completed: 0, reset: 0, neutral: 0, outOfScope: 0 };
    for (const pair of page) {
      const status = await finalizeOne(db, { ...pair, environment, weeklyKey: input.weeklyKey, now });
      if (status === "cadence_complete") counts.completed += 1;
      else if (status === "incomplete_reset") counts.reset += 1;
      else if (status === "out_of_scope") counts.outOfScope += 1;
      else counts.neutral += 1;
    }
    const last = page.at(-1); const nextCursor = eligible.length > limit && last ? `${last.learnerId} ${last.appId}` : null;
    const result = { ...counts, nextCursor };
    await completeReceipt(db, "finalize_week", eventId, result, now);
    return result;
  });
}

async function rebuildState(db: DbClient, learnerId: string, appId: string, environment: string, now: Date) {
  const rows = await db.all<WeekRow>(`select * from learner_app_consistency_weeks where learner_id=? and app_id=? and environment=?
    and status<>'open' order by weekly_start_at,weekly_key`, [learnerId, appId, environment]);
  let current = 0; let longest = 0; let gap = false; let latest: string | null = null;
  for (const row of rows) {
    if (row.status === "cadence_complete") { current = gap ? 1 : current + 1; longest = Math.max(longest, current); gap = false; latest = row.weekly_key; }
    else if (row.status === "incomplete_reset") { current = 0; gap = false; }
    else if (row.status === "out_of_scope") gap = true;
  }
  const timezone = await learnerTimezone(db, learnerId); const bounds = currentIsoWeekBounds(now, timezone);
  const source = await usage(db, learnerId, appId, bounds.weeklyKey);
  return writeState(db, { learnerId, appId, environment, currentStreakWeeks: current, longestStreakWeeks: longest,
    currentWeekKey: bounds.weeklyKey, currentWeekProgress: Math.min(2, source.standard_sessions_funded),
    latestCompletedWeekKey: latest, lastComputedUsageVersion: source.version, timezone, now });
}

function assertOptionalWeekRange(fromWeek?: string, toWeek?: string) {
  for (const value of [fromWeek, toWeek]) {
    if (!value) continue;
    try { isoWeekBounds(value, "Asia/Kolkata"); }
    catch { throw new ConsistencyError("CONSISTENCY_WEEK_INVALID"); }
  }
  if (fromWeek && toWeek && fromWeek > toWeek) throw new ConsistencyError("CONSISTENCY_WEEK_INVALID");
}

async function reconciliationWeekKeys(db: DbClient, learnerId: string, appId: string, environment: string,
  fromWeek?: string, toWeek?: string) {
  const keys = new Set<string>();
  for (const row of await db.all<{ weekly_key: string }>(`select weekly_key from learner_app_consistency_weeks
    where learner_id=? and app_id=? and environment=?`, [learnerId, appId, environment])) {
    keys.add(row.weekly_key);
  }
  for (const row of await db.all<{ week_key: string }>(`select week_key from learner_app_week_usage
    where learner_id=? and app_id=?`, [learnerId, appId])) keys.add(row.week_key);
  return [...keys].filter((key) => (!fromWeek || key >= fromWeek) && (!toWeek || key <= toWeek)).sort();
}

async function reconcilePairWeeks(db: DbClient, learnerId: string, appId: string, environment: string,
  fromWeek: string | undefined, toWeek: string | undefined, now: Date) {
  const timezone = await learnerTimezone(db, learnerId);
  for (const weeklyKey of await reconciliationWeekKeys(db, learnerId, appId, environment, fromWeek, toWeek)) {
    const source = await usage(db, learnerId, appId, weeklyKey);
    const existing = await weekRow(db, learnerId, appId, environment, weeklyKey);
    if (source.standard_sessions_funded >= CONSISTENCY_TARGET) {
      const secondSessionId = await completedSessionId(db, learnerId, appId, weeklyKey);
      if (!secondSessionId) throw new ConsistencyError("CONSISTENCY_SOURCE_CONFLICT");
      if (existing?.status === "cadence_complete") {
        if (existing.cadence_completed_by_session_id !== secondSessionId) {
          throw new ConsistencyError("CONSISTENCY_SOURCE_CONFLICT");
        }
        continue;
      }
      await completeWeek(db, { learnerId, appId, environment, weeklyKey, timezone,
        qualifyingCount: source.standard_sessions_funded, usageVersion: source.version,
        sessionId: secondSessionId, now });
      continue;
    }
    const week = existing ?? await ensureWeek(db, { learnerId, appId, environment, weeklyKey, timezone, now });
    if (week.status === "open" && isoWeekBounds(weeklyKey, timezone).endAt <= now) {
      await finalizeOne(db, { learnerId, appId, environment, weeklyKey, timezone, now });
    }
  }
}

async function reconciliationPairs(db: DbClient, input: { learnerId?: string; appId?: string; environment: string }) {
  const pairs = new Map<string, { learner_id: string; app_id: string }>();
  const add = (rows: { learner_id: string; app_id: string }[]) => {
    for (const row of rows) {
      if (input.learnerId && row.learner_id !== input.learnerId) continue;
      if (input.appId && row.app_id !== input.appId) continue;
      pairs.set(`${row.learner_id} ${row.app_id}`, row);
    }
  };
  add(await db.all<{ learner_id: string; app_id: string }>("select learner_id,app_id from learner_app_consistency where environment=?",
    [input.environment]));
  add(await db.all<{ learner_id: string; app_id: string }>("select distinct learner_id,app_id from learner_app_consistency_weeks where environment=?",
    [input.environment]));
  add(await db.all<{ learner_id: string; app_id: string }>("select learner_id,app_id from learner_app_effective_entitlements where environment=?",
    [input.environment]));
  add(await db.all<{ learner_id: string; app_id: string }>(`select distinct s.learner_id,s.app_id from learner_sessions s
    join learner_app_week_usage u on u.learner_id=s.learner_id and u.app_id=s.app_id and u.week_key=s.week_key
    where coalesce(s.deployment_environment,'production')=? and s.source='standard_monthly'
      and s.usable_launch_established_at is not null`, [input.environment]));
  return [...pairs.values()].sort((a, b) => a.learner_id.localeCompare(b.learner_id) || a.app_id.localeCompare(b.app_id));
}

export async function reconcileConsistency(input: { learnerId?: string; appId?: string; environment?: string;
  fromWeek?: string; toWeek?: string; cursor?: string | null; limit: number; runIdempotencyKey: string;
  principalId: string; now?: Date }): Promise<ReconcileConsistencyResult> {
  const environment = input.environment ?? "production"; assertEnvironment(environment);
  const now = input.now ?? new Date(); const limit = assertLimit(input.limit, 100); const cursor = input.cursor ?? "";
  assertOptionalWeekRange(input.fromWeek, input.toWeek);
  if (!input.runIdempotencyKey || input.runIdempotencyKey.length > 160) {
    throw new ConsistencyError("IDEMPOTENCY_KEY_REUSED");
  }
  const eventId = `reconcile:${environment}:${input.runIdempotencyKey}:${cursor}`;
  const requestHash = digest({ learnerId: input.learnerId ?? null, appId: input.appId ?? null, environment,
    fromWeek: input.fromWeek ?? null, toWeek: input.toWeek ?? null, cursor, limit });
  return resolveDbClient().transaction(async (db) => {
    const cached = await beginOrReadReceipt(db, { action: "reconcile", eventId, requestHash, learnerId: input.learnerId,
      appId: input.appId, environment, runIdempotencyKey: input.runIdempotencyKey, cursor,
      principalId: input.principalId, now });
    if (cached) return cached as ReconcileConsistencyResult;
    const pairs = await reconciliationPairs(db, { learnerId: input.learnerId, appId: input.appId, environment });
    const selected = pairs.filter((pair) => `${pair.learner_id} ${pair.app_id}` > cursor).slice(0, limit);
    let healthy = 0; let repaired = 0; let conflict = 0; let error = 0;
    for (const pair of selected) {
      try {
        const before = (await stateRow(db, pair.learner_id, pair.app_id, environment))?.state_hash;
        await reconcilePairWeeks(db, pair.learner_id, pair.app_id, environment, input.fromWeek, input.toWeek, now);
        const after = (await rebuildState(db, pair.learner_id, pair.app_id, environment, now)).state_hash;
        if (before === after) healthy += 1; else repaired += 1;
      } catch (caught) { if (caught instanceof ConsistencyError && caught.code === "CONSISTENCY_SOURCE_CONFLICT") conflict += 1; else error += 1; }
    }
    const last = selected.at(-1); const more = pairs.some((pair) => last && `${pair.learner_id} ${pair.app_id}` > `${last.learner_id} ${last.app_id}`);
    const result = { healthy, repaired, conflict, error, nextCursor: more && last ? `${last.learner_id} ${last.app_id}` : null };
    await completeReceipt(db, "reconcile", eventId, result, now); return result;
  });
}
