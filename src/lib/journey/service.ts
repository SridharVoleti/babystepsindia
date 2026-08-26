import { createHash, randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { erasePersonalAndLearningData } from "@/lib/data-retention/service";

export type JourneyEventType = "lesson_completed" | "achievement_earned" | "milestone_reached";
export type JourneyOrder = "desc" | "asc";

export type JourneyEventView = {
  journeyEventId: string;
  eventType: JourneyEventType;
  eventAt: string;
  displayDate: string;
  title: string;
  shortDescription: string | null;
  iconAssetKey: string | null;
  sourceApp: { appId: string; appName: string };
};

export type JourneyRetentionView = {
  state: "active" | "inactive_retention" | "purged";
  deleteAfter: string | null;
  retainedUntilDate: string | null;
};

export type CreateJourneyMilestoneInput = {
  appJourneyMilestoneKey: string;
  journeyInstanceKey: string;
  title: string;
  shortDescription?: string | null;
  iconAssetKey?: string | null;
  occurredAt: string;
  basedOnProgressVersion?: number | null;
  sourceCompletionId?: string | null;
  sourceAchievementId?: string | null;
  idempotencyKey: string;
};

export type JourneyAppContext = {
  learnerId: string;
  appId: string;
  releaseId: string;
  environment: string;
};

type RetentionRow = {
  learner_id: string;
  state: "active" | "inactive_retention" | "purged";
  inactive_since: string | null;
  journey_delete_after: string | null;
  retention_generation: number;
  purged_at: string | null;
  purged_through_at: string | null;
  state_version: number;
};

type JourneyEventRow = {
  journey_event_id: string;
  learner_id: string;
  app_id: string;
  retention_generation: number;
  event_type: JourneyEventType;
  event_at: string;
  source_domain: "lesson_completion" | "achievement" | "app_milestone";
  source_id: string;
  title_snapshot: string;
  short_description_snapshot: string | null;
  icon_asset_key: string | null;
  app_name: string;
};

type LessonOutboxRow = {
  id: string; completion_id: string; learner_id: string; app_id: string; release_id: string;
  lesson_key: string; completed_at: string; title_snapshot: string;
  short_description_snapshot: string | null; icon_asset_key: string | null;
  source_state_hash: string; status: "pending" | "processed" | "failed"; created_at: string;
};

type AchievementOutboxRow = {
  id: string; achievement_id: string; learner_id: string; app_id: string;
  action: "upsert" | "remove"; source_state_hash: string;
  status: "pending" | "processed" | "failed"; created_at: string;
};

type AchievementProjectionRow = {
  id: string; learner_id: string; app_id: string; title: string; short_description: string | null;
  badge_asset_key: string | null; earned_at: string; revoked_at: string | null;
};

type JourneyContractRow = {
  app_id: string; release_id: string; journey_contract_version: string;
  lesson_display_metadata: number; milestone_display_metadata: number;
  allowed_icon_asset_keys_json: string; status: "pending" | "approved" | "blocked";
};

export class JourneyError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "JourneyError"; }
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PAYLOAD_BYTES = 2048;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const KOLKATA_OFFSET_MS = 330 * 60 * 1000;

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeText(value: unknown, maxLength: number, required: boolean) {
  if (typeof value !== "string") throw new JourneyError("JOURNEY_CONTENT_INVALID");
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if ((required && !normalized) || normalized.length > maxLength || /[<>]/.test(normalized) ||
      /(?:https?:\/\/|www\.|javascript:|bearer\s+|api[_-]?key|access[_-]?token|refresh[_-]?token)/i.test(normalized)) {
    throw new JourneyError("JOURNEY_CONTENT_INVALID");
  }
  return normalized;
}

function optionalText(value: unknown, maxLength: number) {
  if (value === undefined || value === null || value === "") return null;
  return normalizeText(value, maxLength, false) || null;
}

export function addTwelveCalendarMonthsKolkata(value: Date) {
  if (!Number.isFinite(value.getTime())) throw new JourneyError("JOURNEY_TIME_INVALID");
  const local = new Date(value.getTime() + KOLKATA_OFFSET_MS);
  const year = local.getUTCFullYear() + 1;
  const month = local.getUTCMonth();
  const day = Math.min(local.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  const targetLocal = Date.UTC(year, month, day, local.getUTCHours(), local.getUTCMinutes(),
    local.getUTCSeconds(), local.getUTCMilliseconds());
  return new Date(targetLocal - KOLKATA_OFFSET_MS);
}

function kolkataDate(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric",
    month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === name)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function retentionRow(db: DbClient, learnerId: string) {
  return db.get<RetentionRow>("select * from learner_journey_retention_state where learner_id=?", [learnerId]);
}

// Retention follows commercial entitlement truth, not login/session activity.
// A paid subscription still counts through a security suspension; a dynamic
// BI-003 grace window counts even if the materialized entitlement row is stale.
export async function hasRetentionActiveEntitlement(learnerId: string, now: Date) {
  const db = resolveDbClient();
  const nowIso = now.toISOString();
  const materialized = await db.get(`select 1 as x from learner_app_effective_entitlements
    where learner_id=? and state in ('active','approved_grace')
      and (access_until is null or access_until>?) limit 1`, [learnerId, nowIso]);
  if (materialized) return true;
  const subscription = await db.get(`select 1 as x from subscriptions s
    where s.assigned_learner_id=? and exists(
      select 1 from product_version_apps pva where pva.product_id=s.product_id
        and pva.product_version=s.product_version)
      and ((s.payment_state='paid' and s.current_period_end>?)
        or (s.payment_state='past_due_grace' and s.grace_ends_at>?)) limit 1`,
    [learnerId, nowIso, nowIso]);
  return !!subscription;
}

export async function reconcileLearnerRetentionState(learnerId: string, transitionAt: Date, now: Date = transitionAt) {
  const db = resolveDbClient();
  const active = await hasRetentionActiveEntitlement(learnerId, now);
  const existing = await retentionRow(db, learnerId);
  const timestamp = now.toISOString();
  if (!existing) {
    const inactiveSince = active ? null : transitionAt.toISOString();
    const deleteAfter = inactiveSince ? addTwelveCalendarMonthsKolkata(new Date(inactiveSince)).toISOString() : null;
    await db.run(`insert into learner_journey_retention_state
      (learner_id,state,inactive_since,journey_delete_after,retention_generation,state_version,created_at,updated_at)
      values(?,?,?,?,1,1,?,?)`, [learnerId, active ? "active" : "inactive_retention",
        inactiveSince, deleteAfter, timestamp, timestamp]);
    return (await retentionRow(db, learnerId))!;
  }
  if (active && existing.state !== "active") {
    await db.run(`update learner_journey_retention_state set state='active',inactive_since=null,
      journey_delete_after=null,state_version=state_version+1,updated_at=? where learner_id=?`,
      [timestamp, learnerId]);
  } else if (!active && existing.state === "active") {
    const inactiveSince = transitionAt.toISOString();
    await db.run(`update learner_journey_retention_state set state='inactive_retention',inactive_since=?,
      journey_delete_after=?,state_version=state_version+1,updated_at=? where learner_id=?`,
      [inactiveSince, addTwelveCalendarMonthsKolkata(transitionAt).toISOString(), timestamp, learnerId]);
  }
  return (await retentionRow(db, learnerId))!;
}

async function ensureRetentionState(db: DbClient, learnerId: string, now: Date) {
  return reconcileLearnerRetentionState(learnerId, now, now);
}

function materializationAllowed(state: RetentionRow, eventAt: string) {
  if (state.state === "purged") return false;
  return !state.purged_through_at || eventAt > state.purged_through_at;
}

async function receiptResult(db: DbClient, input: {
  learnerId: string; appId: string; generation: number; sourceDomain: string; sourceId: string;
  action: "upsert" | "remove"; idempotencyKey: string; requestHash: string;
  resultStatus: "created" | "replayed" | "removed" | "ignored_purged"; now: Date;
}) {
  await db.run(`insert into journey_mutation_receipts
    (id,learner_id,app_id,retention_generation,source_domain,source_id,action,idempotency_key,
     request_hash,result_status,created_at,completed_at) values(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [randomUUID(), input.learnerId, input.appId, input.generation, input.sourceDomain, input.sourceId,
      input.action, input.idempotencyKey, input.requestHash, input.resultStatus,
      input.now.toISOString(), input.now.toISOString()]);
}

async function projectEvent(input: {
  learnerId: string; appId: string; eventType: JourneyEventType; eventAt: string;
  sourceDomain: "lesson_completion" | "achievement" | "app_milestone"; sourceId: string;
  title: string; shortDescription: string | null; iconAssetKey: string | null;
  action: "upsert" | "remove"; idempotencyKey: string; requestHash: string; now: Date;
}) {
  return resolveDbClient().transaction(async (db) => {
    const state = await ensureRetentionState(db, input.learnerId, input.now);
    const prior = await db.get<{ request_hash: string; result_status: string }>(`select request_hash,result_status from journey_mutation_receipts
      where learner_id=? and app_id=? and retention_generation=? and source_domain=? and action=? and idempotency_key=?`,
      [input.learnerId, input.appId, state.retention_generation, input.sourceDomain, input.action,
        input.idempotencyKey]);
    if (prior) {
      if (prior.request_hash !== input.requestHash) throw new JourneyError("JOURNEY_IDEMPOTENCY_CONFLICT");
      const existing = await db.get<{ journey_event_id: string }>(`select journey_event_id from learner_app_journey_events
        where learner_id=? and app_id=? and source_domain=? and source_id=?`,
        [input.learnerId, input.appId, input.sourceDomain, input.sourceId]);
      return { created: false, status: prior.result_status, journeyEventId: existing?.journey_event_id };
    }
    if (input.action === "remove") {
      await db.run(`delete from learner_app_journey_events where learner_id=? and app_id=?
        and source_domain=? and source_id=?`, [input.learnerId, input.appId, input.sourceDomain, input.sourceId]);
      await receiptResult(db, { ...input, generation: state.retention_generation, resultStatus: "removed" });
      return { created: false, status: "removed" };
    }
    if (!materializationAllowed(state, input.eventAt)) {
      await receiptResult(db, { ...input, generation: state.retention_generation, resultStatus: "ignored_purged" });
      return { created: false, status: "ignored_purged" };
    }
    const existing = await db.get<Record<string, unknown>>(`select journey_event_id,event_type,event_at,title_snapshot,
      short_description_snapshot,icon_asset_key from learner_app_journey_events
      where learner_id=? and app_id=? and source_domain=? and source_id=?`,
      [input.learnerId, input.appId, input.sourceDomain, input.sourceId]);
    if (existing) {
      const same = existing.event_type === input.eventType && existing.event_at === input.eventAt &&
        existing.title_snapshot === input.title && existing.short_description_snapshot === input.shortDescription &&
        existing.icon_asset_key === input.iconAssetKey;
      if (!same) throw new JourneyError("JOURNEY_SOURCE_CONFLICT");
      await receiptResult(db, { ...input, generation: state.retention_generation, resultStatus: "replayed" });
      return { created: false, status: "replayed", journeyEventId: existing.journey_event_id as string };
    }
    const id = randomUUID();
    await db.run(`insert into learner_app_journey_events
      (journey_event_id,learner_id,app_id,retention_generation,event_type,event_at,source_domain,source_id,
       title_snapshot,short_description_snapshot,icon_asset_key,source_status,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?,'active',?,?)`,
      [id, input.learnerId, input.appId, state.retention_generation, input.eventType, input.eventAt,
        input.sourceDomain, input.sourceId, input.title, input.shortDescription, input.iconAssetKey,
        input.now.toISOString(), input.now.toISOString()]);
    await receiptResult(db, { ...input, generation: state.retention_generation, resultStatus: "created" });
    return { created: true, status: "created", journeyEventId: id };
  });
}

function projectionFailureEnabled(domain: "lesson" | "achievement") {
  return (process.env.JOURNEY_PROJECTION_FAILURE_FOR_TESTS ?? "").split(",").includes(domain);
}

export async function projectLessonOutbox(outboxId: string, input: { markProcessed: boolean; now: Date }) {
  const db = resolveDbClient();
  const row = await db.get<LessonOutboxRow>("select * from lesson_journey_projection_outbox where id=?", [outboxId]);
  if (!row) return { repaired: false, skipped: true };
  try {
    if (projectionFailureEnabled("lesson")) throw new JourneyError("JOURNEY_PROJECTION_UNAVAILABLE");
    const result = await projectEvent({ learnerId: row.learner_id, appId: row.app_id, eventType: "lesson_completed",
      eventAt: row.completed_at, sourceDomain: "lesson_completion", sourceId: row.completion_id,
      title: row.title_snapshot, shortDescription: row.short_description_snapshot, iconAssetKey: row.icon_asset_key,
      action: "upsert", idempotencyKey: `lesson-outbox:${row.id}`, requestHash: row.source_state_hash, now: input.now });
    if (input.markProcessed) await db.run(`update lesson_journey_projection_outbox set status='processed',processed_at=? where id=?`,
      [input.now.toISOString(), row.id]);
    return { repaired: result.status === "created", skipped: result.status === "ignored_purged" };
  } catch (error) {
    await db.run("update lesson_journey_projection_outbox set status='failed' where id=?", [row.id]);
    throw error;
  }
}

export async function projectAchievementOutbox(outboxId: string, input: { markProcessed: boolean; now: Date }) {
  const db = resolveDbClient();
  const row = await db.get<AchievementOutboxRow>("select * from achievement_journey_projection_outbox where id=?", [outboxId]);
  if (!row) return { repaired: false, skipped: true };
  try {
    if (projectionFailureEnabled("achievement")) throw new JourneyError("JOURNEY_PROJECTION_UNAVAILABLE");
    const achievement = await db.get<AchievementProjectionRow>(`select id,learner_id,app_id,title,short_description,badge_asset_key,
      earned_at,revoked_at from learner_achievements where id=?`, [row.achievement_id]);
    if (!achievement) return { repaired: false, skipped: true };
    const action = row.action === "remove" || achievement.revoked_at ? "remove" : "upsert";
    const result = await projectEvent({ learnerId: achievement.learner_id, appId: achievement.app_id,
      eventType: "achievement_earned", eventAt: achievement.earned_at, sourceDomain: "achievement",
      sourceId: achievement.id, title: achievement.title, shortDescription: achievement.short_description,
      iconAssetKey: achievement.badge_asset_key, action,
      idempotencyKey: `achievement-outbox:${row.id}`, requestHash: row.source_state_hash, now: input.now });
    if (input.markProcessed) await db.run(`update achievement_journey_projection_outbox set status='processed',processed_at=? where id=?`,
      [input.now.toISOString(), row.id]);
    return { repaired: result.status === "created" || result.status === "removed",
      skipped: result.status === "ignored_purged" };
  } catch (error) {
    await db.run("update achievement_journey_projection_outbox set status='failed' where id=?", [row.id]);
    throw error;
  }
}

async function contractFor(db: DbClient, appId: string, releaseId: string) {
  return db.get<JourneyContractRow>("select * from app_release_journey_contracts where app_id=? and release_id=?",
    [appId, releaseId]);
}

export async function registerReleaseJourneyContract(input: {
  appId: string; releaseId: string; journeyContractVersion: string;
  lessonDisplayMetadata: boolean; milestoneDisplayMetadata: boolean;
  allowedIconAssetKeys: string[]; now: Date;
}) {
  if (!VERSION_PATTERN.test(input.journeyContractVersion) || input.allowedIconAssetKeys.length > 100 ||
      input.allowedIconAssetKeys.some((key) => !KEY_PATTERN.test(key))) {
    throw new JourneyError("JOURNEY_CONTRACT_INVALID");
  }
  await resolveDbClient().run(`insert into app_release_journey_contracts
    (app_id,release_id,journey_contract_version,lesson_display_metadata,milestone_display_metadata,
     allowed_icon_asset_keys_json,status,created_at,updated_at) values(?,?,?,?,?,?,'pending',?,?)
    on conflict(app_id,release_id) do update set journey_contract_version=excluded.journey_contract_version,
      lesson_display_metadata=excluded.lesson_display_metadata,milestone_display_metadata=excluded.milestone_display_metadata,
      allowed_icon_asset_keys_json=excluded.allowed_icon_asset_keys_json,status='pending',updated_at=excluded.updated_at`,
    [input.appId, input.releaseId, input.journeyContractVersion, input.lessonDisplayMetadata ? 1 : 0,
      input.milestoneDisplayMetadata ? 1 : 0, JSON.stringify([...new Set(input.allowedIconAssetKeys)]),
      input.now.toISOString(), input.now.toISOString()]);
}

export async function validateReleaseJourneyContract(appId: string, releaseId: string, now: Date) {
  const db = resolveDbClient();
  const contract = await contractFor(db, appId, releaseId);
  if (!contract) return { declared: false, passed: true };
  const assets = JSON.parse(contract.allowed_icon_asset_keys_json) as string[];
  const missing: string[] = [];
  for (const asset of assets) {
    const approved = await db.get("select 1 as x from approved_app_icons where id=? and active=true", [asset]);
    if (!approved) missing.push(asset);
  }
  const passed = missing.length === 0;
  await db.run(`update app_release_journey_contracts set status=?,validation_report_json=?,validated_at=?,updated_at=?
    where app_id=? and release_id=?`, [passed ? "approved" : "blocked",
      JSON.stringify({ passed, missingAssetKeys: missing }), now.toISOString(), now.toISOString(), appId, releaseId]);
  return { declared: true, passed, missingAssetKeys: missing };
}

async function assertJourneyContract(db: DbClient, context: JourneyAppContext, iconAssetKey: string | null, capability: "lesson" | "milestone") {
  const contract = await contractFor(db, context.appId, context.releaseId);
  if (!contract || contract.status !== "approved" ||
      (capability === "lesson" ? contract.lesson_display_metadata !== 1 : contract.milestone_display_metadata !== 1)) {
    throw new JourneyError("JOURNEY_CONTRACT_UNSUPPORTED");
  }
  if (iconAssetKey) {
    const allowed = JSON.parse(contract.allowed_icon_asset_keys_json) as string[];
    const generic = await db.get("select 1 as x from approved_app_icons where id=? and active=true", [iconAssetKey]);
    if (!allowed.includes(iconAssetKey) && !generic) throw new JourneyError("JOURNEY_CONTENT_INVALID");
  }
}

export async function normalizeLessonJourneyDisplay(context: JourneyAppContext, input: {
  journeyContractVersion?: string; title?: string; shortDescription?: string | null; iconAssetKey?: string | null;
}, lessonKey: string) {
  if (input.journeyContractVersion === undefined && input.title === undefined && input.shortDescription === undefined &&
      input.iconAssetKey === undefined) {
    return { title: normalizeText(lessonKey, 100, true), shortDescription: null, iconAssetKey: null };
  }
  const db = resolveDbClient();
  const title = normalizeText(input.title, 100, true);
  const shortDescription = optionalText(input.shortDescription, 240);
  const iconAssetKey = optionalText(input.iconAssetKey, 128);
  const contract = await contractFor(db, context.appId, context.releaseId);
  if (!contract || contract.journey_contract_version !== input.journeyContractVersion) {
    throw new JourneyError("JOURNEY_CONTRACT_UNSUPPORTED");
  }
  await assertJourneyContract(db, context, iconAssetKey, "lesson");
  const payload = { title, shortDescription, iconAssetKey };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) throw new JourneyError("JOURNEY_PAYLOAD_TOO_LARGE");
  return payload;
}

async function assertMilestoneSource(db: DbClient, context: JourneyAppContext, input: CreateJourneyMilestoneInput) {
  const supplied = [input.basedOnProgressVersion, input.sourceCompletionId, input.sourceAchievementId]
    .filter((value) => value !== undefined && value !== null);
  if (supplied.length === 0) throw new JourneyError("JOURNEY_SOURCE_NOT_ACKNOWLEDGED");
  let acknowledged = false;
  if (input.basedOnProgressVersion !== undefined && input.basedOnProgressVersion !== null) {
    if (!Number.isInteger(input.basedOnProgressVersion) || input.basedOnProgressVersion < 1) {
      throw new JourneyError("JOURNEY_SOURCE_NOT_ACKNOWLEDGED");
    }
    const row = await db.get<{ progress_version: number }>("select progress_version from learner_app_progress where learner_id=? and app_id=?",
      [context.learnerId, context.appId]);
    acknowledged = !!row && row.progress_version >= input.basedOnProgressVersion;
  }
  if (input.sourceCompletionId) {
    acknowledged = acknowledged || !!(await db.get(`select 1 as x from lesson_completions
      where completion_id=? and learner_id=? and app_id=?`, [input.sourceCompletionId, context.learnerId, context.appId]));
  }
  if (input.sourceAchievementId) {
    // EG-001 achievements already project themselves. Treating one as an
    // app milestone too would list the same badge twice.
    throw new JourneyError("JOURNEY_ACHIEVEMENT_ALREADY_PROJECTED");
  }
  if (!acknowledged) throw new JourneyError("JOURNEY_SOURCE_NOT_ACKNOWLEDGED");
}

export async function createJourneyMilestone(context: JourneyAppContext, raw: CreateJourneyMilestoneInput, now: Date) {
  const db = resolveDbClient();
  if (!KEY_PATTERN.test(raw.appJourneyMilestoneKey) || !KEY_PATTERN.test(raw.journeyInstanceKey) ||
      !KEY_PATTERN.test(raw.idempotencyKey)) throw new JourneyError("JOURNEY_CONTENT_INVALID");
  const title = normalizeText(raw.title, 100, true);
  const shortDescription = optionalText(raw.shortDescription, 240);
  const iconAssetKey = optionalText(raw.iconAssetKey, 128);
  const eventTime = new Date(raw.occurredAt);
  if (!Number.isFinite(eventTime.getTime()) || eventTime.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) {
    throw new JourneyError("JOURNEY_TIME_INVALID");
  }
  const firstAccess = await db.get<{ first_access: string | null }>(`select min(period_start) first_access from learner_app_entitlement_periods
    where learner_id=? and app_id=?`, [context.learnerId, context.appId]);
  if (firstAccess?.first_access && eventTime < new Date(firstAccess.first_access)) throw new JourneyError("JOURNEY_TIME_INVALID");
  await assertJourneyContract(db, context, iconAssetKey, "milestone");
  await assertMilestoneSource(db, context, raw);
  const normalized = { ...raw, title, shortDescription, iconAssetKey, occurredAt: eventTime.toISOString() };
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_PAYLOAD_BYTES) {
    throw new JourneyError("JOURNEY_PAYLOAD_TOO_LARGE");
  }
  const sourceId = `${raw.appJourneyMilestoneKey}:${raw.journeyInstanceKey}`;
  const result = await projectEvent({ learnerId: context.learnerId, appId: context.appId,
    eventType: "milestone_reached", eventAt: eventTime.toISOString(), sourceDomain: "app_milestone",
    sourceId, title, shortDescription, iconAssetKey, action: "upsert", idempotencyKey: raw.idempotencyKey,
    requestHash: hash(normalized), now });
  if (result.status === "ignored_purged") throw new JourneyError("JOURNEY_PURGED_OLD_SOURCE");
  return { created: result.created, journeyEventId: result.journeyEventId, eventType: "milestone_reached" as const,
    occurredAt: eventTime.toISOString() };
}

type JourneyCursor = { eventAt: string; id: string; order: JourneyOrder };
function decodeCursor(value: string | null | undefined, order: JourneyOrder) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as JourneyCursor;
    if (cursor.order !== order || !cursor.id || !Number.isFinite(new Date(cursor.eventAt).getTime())) throw new Error();
    return cursor;
  } catch { throw new JourneyError("JOURNEY_CURSOR_INVALID"); }
}

export async function listJourney(input: {
  learnerId: string; appId: string; cursor?: string | null; limit?: number; order?: JourneyOrder;
  exposeRetentionDeadline?: boolean;
}) {
  const db = resolveDbClient();
  const limit = input.limit ?? 50;
  const order = input.order ?? "desc";
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !["asc", "desc"].includes(order)) {
    throw new JourneyError("JOURNEY_QUERY_INVALID");
  }
  const app = await db.get<{ display_name: string }>("select display_name from app_registry where id=?", [input.appId]);
  if (!app) throw new JourneyError("JOURNEY_NOT_FOUND");
  const hasHistory = await db.get(`select 1 as x from learner_app_effective_entitlements where learner_id=? and app_id=?
    union select 1 from learner_app_journey_events where learner_id=? and app_id=? limit 1`,
    [input.learnerId, input.appId, input.learnerId, input.appId]);
  if (!hasHistory) throw new JourneyError("JOURNEY_NOT_FOUND");
  const state = await ensureRetentionState(db, input.learnerId, new Date());
  if (state.state === "purged") throw new JourneyError("JOURNEY_PURGED");
  const cursor = decodeCursor(input.cursor, order);
  const comparator = order === "desc" ? "<" : ">";
  const direction = order === "desc" ? "desc" : "asc";
  const where = [`e.learner_id=?`, `e.app_id=?`, `e.retention_generation=?`];
  const params: (string | number)[] = [input.learnerId, input.appId, state.retention_generation];
  if (cursor) {
    where.push(`(e.event_at${comparator}? or (e.event_at=? and e.journey_event_id${comparator}?))`);
    params.push(cursor.eventAt, cursor.eventAt, cursor.id);
  }
  const rows = await db.all<JourneyEventRow>(`select e.*,a.display_name app_name from learner_app_journey_events e
    join app_registry a on a.id=e.app_id where ${where.join(" and ")}
    order by e.event_at ${direction},e.journey_event_id ${direction} limit ?`,
    [...params, limit + 1]);
  const page = rows.slice(0, limit);
  const tail = page.at(-1);
  const retentionState: JourneyRetentionView = {
    state: state.state,
    deleteAfter: input.exposeRetentionDeadline && state.state === "inactive_retention" ? state.journey_delete_after : null,
    retainedUntilDate: input.exposeRetentionDeadline && state.state === "inactive_retention" && state.journey_delete_after
      ? kolkataDate(state.journey_delete_after) : null,
  };
  return {
    appId: input.appId,
    appName: app.display_name,
    order,
    events: page.map((row): JourneyEventView => ({ journeyEventId: row.journey_event_id,
      eventType: row.event_type, eventAt: row.event_at, displayDate: kolkataDate(row.event_at),
      title: row.title_snapshot, shortDescription: row.short_description_snapshot,
      iconAssetKey: row.icon_asset_key, sourceApp: { appId: row.app_id, appName: row.app_name } })),
    nextCursor: rows.length > limit && tail ? Buffer.from(JSON.stringify({ eventAt: tail.event_at,
      id: tail.journey_event_id, order })).toString("base64url") : null,
    retentionState,
  };
}

export async function purgeLearnerJourneyIfDue(learnerId: string, now: Date) {
  await reconcileLearnerRetentionState(learnerId, now, now);
  const result = await resolveDbClient().transaction(async (db) => {
    const state = await retentionRow(db, learnerId);
    if (!state || state.state !== "inactive_retention" || !state.journey_delete_after ||
        state.journey_delete_after > now.toISOString()) return { purged: false, reason: "not_due" as const };
    if (await hasRetentionActiveEntitlement(learnerId, now)) {
      await reconcileLearnerRetentionState(learnerId, now, now);
      return { purged: false, reason: "reactivated" as const };
    }
    await db.run("delete from journey_mutation_receipts where learner_id=?", [learnerId]);
    await db.run("delete from lesson_journey_projection_outbox where learner_id=?", [learnerId]);
    await db.run("delete from achievement_journey_projection_outbox where learner_id=?", [learnerId]);
    const deletedEvents = (await db.run("delete from learner_app_journey_events where learner_id=?", [learnerId])).changes;
    const timestamp = now.toISOString();
    await db.run(`update learner_journey_retention_state set state='purged',inactive_since=null,
      journey_delete_after=null,retention_generation=retention_generation+1,purged_at=?,purged_through_at=?,
      state_version=state_version+1,updated_at=? where learner_id=? and state='inactive_retention'`,
      [timestamp, timestamp, timestamp, learnerId]);
    return { purged: true as const, deletedEvents };
  });
  // PC-004: the same due-check/generation this journey purge already
  // computed also drives the broader personal/learning-data erasure — one
  // canonical retention timer, one purge. Applied right after the purge
  // transaction commits (not inside it) since it's a separately-converted
  // module's own transaction — erasePersonalAndLearningData is idempotent
  // and replayDeletionObligations already exists as the exact recovery path
  // for a crash between these two steps, so this is not a new atomicity gap.
  if (result.purged) await erasePersonalAndLearningData(learnerId, now);
  return result;
}

export async function reconcileJourney(input: {
  mode: "lifecycle" | "reconcile" | "purge"; learnerId?: string | null; cursor?: string | null;
  limit: number; principalId: string; runIdempotencyKey: string; now: Date;
}) {
  const db = resolveDbClient();
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500 ||
      !KEY_PATTERN.test(input.runIdempotencyKey)) throw new JourneyError("JOURNEY_RECONCILE_INVALID");
  const requestHash = hash({ mode: input.mode, learnerId: input.learnerId ?? null, cursor: input.cursor ?? null,
    limit: input.limit });
  const prior = await db.get<{ request_hash: string; result_json: string | null; status: string }>(
    `select request_hash,result_json,status from journey_retention_job_runs
    where principal_id=? and run_idempotency_key=?`, [input.principalId, input.runIdempotencyKey]);
  if (prior) {
    if (prior.request_hash !== requestHash) throw new JourneyError("JOURNEY_IDEMPOTENCY_CONFLICT");
    if (prior.status === "completed" && prior.result_json) return JSON.parse(prior.result_json);
    throw new JourneyError("JOURNEY_RECONCILE_CONFLICT");
  }
  await db.run(`insert into journey_retention_job_runs
    (principal_id,run_idempotency_key,request_hash,status,created_at) values(?,?,?,'processing',?)`,
    [input.principalId, input.runIdempotencyKey, requestHash, input.now.toISOString()]);
  const result = { active: 0, pending: 0, purged: 0, repaired: 0, skipped: 0, nextCursor: null as string | null };
  try {
    if (input.mode === "reconcile") {
      const learnerClause = input.learnerId ? "and learner_id=?" : "";
      const cursorClause = input.cursor ? "and id>?" : "";
      const args = [...(input.learnerId ? [input.learnerId] : []), ...(input.cursor ? [input.cursor] : []), input.limit + 1];
      const lessonRows = await db.all<LessonOutboxRow>(`select * from lesson_journey_projection_outbox
        where status in ('pending','failed') ${learnerClause} ${cursorClause} order by id limit ?`, args);
      const selected = lessonRows.slice(0, input.limit);
      for (const row of selected) {
        try { const projected = await projectLessonOutbox(row.id, { markProcessed: true, now: input.now });
          result.repaired += projected.repaired ? 1 : 0; result.skipped += projected.skipped ? 1 : 0; }
        catch { result.skipped++; }
      }
      let remaining = input.limit - selected.length;
      if (remaining > 0) {
        const achievementArgs = [...(input.learnerId ? [input.learnerId] : []), remaining + 1];
        const achievementRows = await db.all<AchievementOutboxRow>(`select * from achievement_journey_projection_outbox
          where status in ('pending','failed') ${learnerClause} order by id limit ?`, achievementArgs);
        for (const row of achievementRows.slice(0, remaining)) {
          try { const projected = await projectAchievementOutbox(row.id, { markProcessed: true, now: input.now });
            result.repaired += projected.repaired ? 1 : 0; result.skipped += projected.skipped ? 1 : 0; }
          catch { result.skipped++; }
        }
        remaining -= Math.min(achievementRows.length, remaining);
      }
      const tail = selected.at(-1);
      if (lessonRows.length > input.limit && tail) result.nextCursor = tail.id;
    } else {
      const learners = input.learnerId ? [{ id: input.learnerId }] : await db.all<{ id: string }>(`select id from learners
        where (? is null or id>?) order by id limit ?`, [input.cursor ?? null, input.cursor ?? null, input.limit + 1]);
      for (const learner of learners.slice(0, input.limit)) {
        if (input.mode === "lifecycle") {
          const state = await reconcileLearnerRetentionState(learner.id, input.now, input.now);
          if (state.state === "active") result.active++; else result.pending++;
        } else {
          const purged = await purgeLearnerJourneyIfDue(learner.id, input.now);
          if (purged.purged) result.purged++; else result.skipped++;
        }
      }
      const tail = learners.slice(0, input.limit).at(-1);
      if (learners.length > input.limit && tail) result.nextCursor = tail.id;
    }
    await db.run(`update journey_retention_job_runs set status='completed',result_json=?,completed_at=?
      where principal_id=? and run_idempotency_key=?`, [JSON.stringify(result), input.now.toISOString(),
        input.principalId, input.runIdempotencyKey]);
    return result;
  } catch (error) {
    await db.run("delete from journey_retention_job_runs where principal_id=? and run_idempotency_key=?",
      [input.principalId, input.runIdempotencyKey]);
    throw error;
  }
}
