import { createHash, randomUUID } from "node:crypto";
import { readAppAvailability, SAFE_START_SECONDS } from "@/lib/app-availability/service";
import { readCurrentConsistency } from "@/lib/consistency/service";
import { getDb } from "@/lib/db/client";

export const LEARNING_REMINDER_TEMPLATE_VERSION = "eg006-v1";
export const LEARNING_REMINDER_RETENTION_DAYS = 90;
export const LEARNING_REMINDER_MAX_ATTEMPTS = 3;
export type LearningReminderStage = "mid_window" | "final_window";

export class LearningReminderError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "LearningReminderError"; }
}

type PreferenceRow = { parent_id: string; learning_reminder_email_enabled: number; version: number;
  last_idempotency_key: string | null; last_request_hash: string | null; updated_at: string };
type ParentCandidate = { parent_id: string };
type LearnerAppCandidate = { parent_id: string; learner_id: string; learner_name: string; app_id: string;
  app_name: string; environment: string; entitlement_state: string; access_until: string | null;
  effective_version: number };
type BatchRow = { id: string; parent_id: string; reminder_stage: LearningReminderStage; scheduler_run_id: string;
  status: "evaluating" | "ready" | "suppressed" | "sending" | "sent" | "failed";
  item_count: number; template_version: string; expected_parent_identity_version: string | null;
  idempotency_key: string; batch_version: number; created_at: string; updated_at: string; sent_at: string | null };
type ItemRow = { id: string; batch_id: string; parent_id: string; learner_id: string; app_id: string;
  weekly_key: string; reminder_stage: LearningReminderStage; observed_weekly_progress: 0 | 1;
  remaining_normal_sessions: 1 | 2; eligibility_version: number; eligibility_digest: string;
  availability_note: string | null; status: "candidate" | "included" | "suppressed" };
type DeliveryRow = { id: string; batch_id: string; provider_message_id: string | null;
  provider_status: "pending" | "accepted" | "delivered" | "uncertain" | "retry_pending" | "failed";
  destination_identity_version: string; destination_email_hash: string; attempt_count: number;
  provider_idempotency_key: string; api_idempotency_key: string; request_hash: string;
  sent_at: string | null; last_attempt_at: string | null };

export type ReminderEmailProvider = {
  send(input: { to: string; subject: string; text: string; html: string; idempotencyKey: string }):
    { status: "accepted" | "delivered" | "uncertain" | "failed"; providerMessageId?: string | null };
  lookup?(input: { providerMessageId: string | null; idempotencyKey: string }):
    { status: "delivered" | "pending" | "not_found" | "failed" };
};

export const localReminderEmailProvider: ReminderEmailProvider = {
  send(input) {
    return { status: "accepted", providerMessageId: `local:${digest(input.idempotencyKey).slice(0, 24)}` };
  },
  lookup(input) {
    return { status: input.providerMessageId ? "delivered" : "not_found" };
  },
};

function digest(value: unknown) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function assertKey(value: string, code = "LEARNING_REMINDER_IDEMPOTENCY_INVALID") {
  if (!value || value.length > 160 || /[\u0000-\u001f]/.test(value)) throw new LearningReminderError(code);
}

function limit(value: number | undefined, fallback = 20) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > 100) throw new LearningReminderError("LEARNING_REMINDER_PAGE_INVALID");
  return result;
}

function preferenceRow(parentId: string) {
  return getDb().prepare("select * from parent_notification_preferences where parent_id=?")
    .get(parentId) as PreferenceRow | undefined;
}

export function getParentNotificationPreference(parentId: string, now = new Date()) {
  const timestamp = now.toISOString();
  getDb().prepare(`insert or ignore into parent_notification_preferences
    (parent_id,learning_reminder_email_enabled,version,created_at,updated_at) values(?,1,1,?,?)`)
    .run(parentId, timestamp, timestamp);
  const row = preferenceRow(parentId)!;
  return { learningReminderEmailEnabled: !!row.learning_reminder_email_enabled,
    version: row.version, updatedAt: row.updated_at };
}

export function updateParentNotificationPreference(parentId: string, input: {
  learningReminderEmailEnabled: boolean; expectedVersion: number; idempotencyKey: string; now?: Date;
}) {
  assertKey(input.idempotencyKey);
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new LearningReminderError("LEARNING_REMINDER_VERSION_INVALID");
  }
  const now = input.now ?? new Date();
  const requestHash = digest({ enabled: input.learningReminderEmailEnabled, expectedVersion: input.expectedVersion });
  return getDb().transaction(() => {
    getParentNotificationPreference(parentId, now);
    const existing = preferenceRow(parentId)!;
    if (existing.last_idempotency_key === input.idempotencyKey) {
      if (existing.last_request_hash !== requestHash) throw new LearningReminderError("LEARNING_REMINDER_IDEMPOTENCY_CONFLICT");
      return { learningReminderEmailEnabled: !!existing.learning_reminder_email_enabled,
        version: existing.version, updatedAt: existing.updated_at };
    }
    if (existing.version !== input.expectedVersion) throw new LearningReminderError("LEARNING_REMINDER_VERSION_CONFLICT");
    const timestamp = now.toISOString();
    getDb().prepare(`update parent_notification_preferences set learning_reminder_email_enabled=?,version=version+1,
      last_idempotency_key=?,last_request_hash=?,updated_at=? where parent_id=? and version=?`)
      .run(input.learningReminderEmailEnabled ? 1 : 0, input.idempotencyKey, requestHash, timestamp,
        parentId, input.expectedVersion);
    const updated = preferenceRow(parentId)!;
    return { learningReminderEmailEnabled: !!updated.learning_reminder_email_enabled,
      version: updated.version, updatedAt: updated.updated_at };
  }).immediate();
}

function stageDue(stage: LearningReminderStage, startAt: string, endAt: string, now: Date) {
  const start = new Date(startAt).getTime(); const end = new Date(endAt).getTime(); const current = now.getTime();
  if (![start, end, current].every(Number.isFinite) || current < start || current >= end) return false;
  return stage === "mid_window" ? current >= start + (end - start) / 2
    : current >= end - 24 * 60 * 60 * 1000;
}

function mergeBlockedMilliseconds(windows: { starts_at: string; ends_at: string }[], from: Date, to: Date) {
  const intervals = windows.map((window) => [Math.max(from.getTime(), new Date(window.starts_at).getTime()),
    Math.min(to.getTime(), new Date(window.ends_at).getTime())] as [number, number])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  let blocked = 0; let start = -1; let end = -1;
  for (const interval of intervals) {
    if (interval[0] > end) { if (end > start) blocked += end - start; [start, end] = interval; }
    else end = Math.max(end, interval[1]);
  }
  if (end > start) blocked += end - start;
  return blocked;
}

function availabilityOpportunity(appId: string, environment: string, remaining: 1 | 2,
  weeklyEndAt: string, now: Date) {
  const availability = readAppAvailability(appId, environment, now);
  if (availability.operationalAvailability === "security_blocked") return { eligible: false, note: null };
  const end = new Date(weeklyEndAt);
  let availableFrom = now;
  let note: string | null = null;
  if (["temporarily_unavailable", "restoring"].includes(availability.operationalAvailability)) {
    if (!availability.expectedReturnAt) return { eligible: false, note: null };
    availableFrom = new Date(availability.expectedReturnAt);
    if (!Number.isFinite(availableFrom.getTime()) || availableFrom >= end) return { eligible: false, note: null };
    note = "This app is temporarily unavailable, with time expected to remain later this week.";
  }
  const windows = getDb().prepare(`select starts_at,ends_at from app_maintenance_windows
    where app_id=? and environment=? and status='scheduled' and starts_at<? and ends_at>?
    order by starts_at,id`).all(appId, environment, end.toISOString(), availableFrom.toISOString()) as
    { starts_at: string; ends_at: string }[];
  const usableMs = Math.max(0, end.getTime() - availableFrom.getTime()
    - mergeBlockedMilliseconds(windows, availableFrom, end));
  return { eligible: usableMs >= remaining * SAFE_START_SECONDS * 1000, note };
}

function candidateEligibility(candidate: LearnerAppCandidate, stage: LearningReminderStage, now: Date,
  expectedWeeklyKey?: string) {
  if (!["active", "approved_grace"].includes(candidate.entitlement_state)
    || (candidate.access_until && candidate.access_until <= now.toISOString())) return null;
  const consistency = readCurrentConsistency(candidate.learner_id, candidate.app_id, candidate.environment, now);
  if (expectedWeeklyKey && consistency.currentWeekKey !== expectedWeeklyKey) return null;
  if (!stageDue(stage, consistency.currentWeekStartAt, consistency.currentWeekEndAt, now)
    || consistency.currentWeekProgress >= 2) return null;
  const remaining = (2 - consistency.currentWeekProgress) as 1 | 2;
  const opportunity = availabilityOpportunity(candidate.app_id, candidate.environment, remaining,
    consistency.currentWeekEndAt, now);
  if (!opportunity.eligible) return null;
  const eligibilityVersion = Math.max(candidate.effective_version, consistency.stateVersion);
  const eligibilityDigest = digest({ candidate: { learnerId: candidate.learner_id, appId: candidate.app_id,
    effectiveVersion: candidate.effective_version }, consistency: { weeklyKey: consistency.currentWeekKey,
    progress: consistency.currentWeekProgress, startAt: consistency.currentWeekStartAt,
    endAt: consistency.currentWeekEndAt, stateVersion: consistency.stateVersion }, opportunity });
  return { weeklyKey: consistency.currentWeekKey, observedProgress: consistency.currentWeekProgress as 0 | 1,
    remaining, eligibilityVersion, eligibilityDigest, availabilityNote: opportunity.note };
}

function learnerAppCandidates(parentId: string, now: Date) {
  return getDb().prepare(`select l.owner_parent_id parent_id,l.id learner_id,l.display_name learner_name,
    a.id app_id,a.display_name app_name,e.environment,e.state entitlement_state,e.access_until,
    e.effective_version from learner_app_effective_entitlements e
    join learners l on l.id=e.learner_id join app_registry a on a.id=e.app_id
    where l.owner_parent_id=? and e.environment='production' and e.state in ('active','approved_grace')
      and e.integrity_state='healthy' and (e.access_until is null or e.access_until>?)
      and a.registry_status='active' order by l.created_at,l.id,a.display_name,a.id limit 100`)
    .all(parentId, now.toISOString()) as LearnerAppCandidate[];
}

function recipient(parentId: string) {
  const row = getDb().prepare(`select u.email,u.email_verified_at,p.account_status from users u
    join profiles p on p.id=u.id where u.id=?`).get(parentId) as
    { email: string; email_verified_at: string | null; account_status: string } | undefined;
  if (!row || row.account_status !== "active" || !row.email_verified_at) return null;
  const identityVersion = digest({ email: row.email.toLowerCase(), verifiedAt: row.email_verified_at });
  return { email: row.email, identityVersion, emailHash: digest(row.email.trim().toLowerCase()) };
}

function startJob(principalId: string, operation: "evaluate" | "reconcile", key: string,
  requestHash: string, now: Date) {
  const existing = getDb().prepare(`select request_hash,status,result_json from learning_reminder_job_runs
    where principal_id=? and operation=? and run_idempotency_key=?`).get(principalId, operation, key) as
    { request_hash: string; status: string; result_json: string | null } | undefined;
  if (existing) {
    if (existing.request_hash !== requestHash) throw new LearningReminderError("LEARNING_REMINDER_IDEMPOTENCY_CONFLICT");
    if (existing.status !== "completed" || !existing.result_json) throw new LearningReminderError("LEARNING_REMINDER_RUN_IN_PROGRESS");
    return JSON.parse(existing.result_json) as unknown;
  }
  getDb().prepare(`insert into learning_reminder_job_runs
    (principal_id,operation,run_idempotency_key,request_hash,status,created_at)
    values(?,?,?,?, 'processing',?)`).run(principalId, operation, key, requestHash, now.toISOString());
  return null;
}

function finishJob(principalId: string, operation: "evaluate" | "reconcile", key: string,
  result: unknown, now: Date) {
  getDb().prepare(`update learning_reminder_job_runs set status='completed',result_json=?,completed_at=?
    where principal_id=? and operation=? and run_idempotency_key=?`)
    .run(JSON.stringify(result), now.toISOString(), principalId, operation, key);
  return result;
}

function encodeCursor(parentId: string) { return Buffer.from(parentId).toString("base64url"); }
function decodeCursor(cursor: string | null | undefined) {
  if (!cursor) return "";
  try { const value = Buffer.from(cursor, "base64url").toString("utf8");
    if (!value || value.length > 200) throw new Error(); return value;
  } catch { throw new LearningReminderError("LEARNING_REMINDER_CURSOR_INVALID"); }
}

export type LearningReminderEvaluationResult = { parentBatches: string[]; batchCount: number; itemCount: number;
  suppressedCount: number; nextCursor: string | null };

export function evaluateLearningReminders(input: { reminderStage: LearningReminderStage; cursor?: string | null;
  limit?: number; runIdempotencyKey: string; principalId: string; now?: Date }): LearningReminderEvaluationResult {
  if (!["mid_window", "final_window"].includes(input.reminderStage)) {
    throw new LearningReminderError("LEARNING_REMINDER_STAGE_INVALID");
  }
  assertKey(input.runIdempotencyKey); const now = input.now ?? new Date(); const pageLimit = limit(input.limit);
  const afterParentId = decodeCursor(input.cursor); const jobKey = `${input.runIdempotencyKey}:${afterParentId}`;
  const requestHash = digest({ stage: input.reminderStage, afterParentId, limit: pageLimit });
  const replay = startJob(input.principalId, "evaluate", jobKey, requestHash, now);
  if (replay) return replay as LearningReminderEvaluationResult;

  const parents = getDb().prepare(`select distinct p.id parent_id from profiles p join users u on u.id=p.id
    join learners l on l.owner_parent_id=p.id join learner_app_effective_entitlements e on e.learner_id=l.id
    left join parent_notification_preferences pref on pref.parent_id=p.id
    where p.account_status='active' and u.email_verified_at is not null
      and coalesce(pref.learning_reminder_email_enabled,1)=1 and e.environment='production'
      and e.state in ('active','approved_grace') and e.integrity_state='healthy'
      and (e.access_until is null or e.access_until>?) and p.id>?
    order by p.id limit ?`).all(now.toISOString(), afterParentId, pageLimit + 1) as ParentCandidate[];
  const page = parents.slice(0, pageLimit); const batchIds: string[] = [];
  let items = 0; let suppressed = 0;
  for (const parent of page) {
    const pref = getParentNotificationPreference(parent.parent_id, now);
    if (!pref.learningReminderEmailEnabled) { suppressed += 1; continue; }
    const identity = recipient(parent.parent_id);
    if (!identity) { suppressed += 1; continue; }
    const eligible: { candidate: LearnerAppCandidate;
      eligibility: NonNullable<ReturnType<typeof candidateEligibility>> }[] = [];
    for (const candidate of learnerAppCandidates(parent.parent_id, now)) {
      try {
        const eligibility = candidateEligibility(candidate, input.reminderStage, now);
        if (eligibility) eligible.push({ candidate, eligibility }); else suppressed += 1;
      } catch { suppressed += 1; }
    }
    if (!eligible.length) { suppressed += 1; continue; }
    const batchId = randomUUID();
    const batchKey = digest({ parentId: parent.parent_id, stage: input.reminderStage,
      runIdempotencyKey: input.runIdempotencyKey });
    getDb().prepare(`insert or ignore into learning_reminder_batches
      (id,parent_id,reminder_stage,scheduler_run_id,status,item_count,template_version,
       expected_parent_identity_version,idempotency_key,batch_version,created_at,updated_at)
      values(?,?,?,?, 'ready',0,?,?,?,1,?,?)`).run(batchId, parent.parent_id, input.reminderStage,
        input.runIdempotencyKey, LEARNING_REMINDER_TEMPLATE_VERSION, identity.identityVersion,
        batchKey, now.toISOString(), now.toISOString());
    const storedBatch = getDb().prepare("select id from learning_reminder_batches where idempotency_key=?")
      .get(batchKey) as { id: string };
    let inserted = 0;
    for (const { candidate, eligibility } of eligible) {
      const result = getDb().prepare(`insert or ignore into learning_reminder_items
        (id,batch_id,parent_id,learner_id,app_id,weekly_key,reminder_stage,observed_weekly_progress,
         remaining_normal_sessions,eligibility_version,eligibility_digest,availability_note,status,created_at,updated_at)
        values(?,?,?,?,?,?,?,?,?,?,?,?, 'candidate',?,?)`).run(randomUUID(), storedBatch.id, parent.parent_id,
          candidate.learner_id, candidate.app_id, eligibility.weeklyKey, input.reminderStage,
          eligibility.observedProgress, eligibility.remaining, eligibility.eligibilityVersion,
          eligibility.eligibilityDigest, eligibility.availabilityNote, now.toISOString(), now.toISOString());
      inserted += result.changes;
    }
    if (inserted > 0) {
      getDb().prepare("update learning_reminder_batches set item_count=?,updated_at=? where id=?")
        .run(inserted, now.toISOString(), storedBatch.id);
      batchIds.push(storedBatch.id); items += inserted;
    } else if (storedBatch.id === batchId) {
      getDb().prepare("delete from learning_reminder_batches where id=?").run(batchId);
      suppressed += 1;
    }
  }
  const last = page.at(-1);
  const result = { parentBatches: batchIds, batchCount: batchIds.length, itemCount: items, suppressedCount: suppressed,
    nextCursor: parents.length > pageLimit && last ? encodeCursor(last.parent_id) : null };
  return finishJob(input.principalId, "evaluate", jobKey, result, now) as typeof result;
}

function batchRow(batchId: string) {
  return getDb().prepare("select * from learning_reminder_batches where id=?").get(batchId) as BatchRow | undefined;
}
function deliveryRow(batchId: string) {
  return getDb().prepare("select * from learning_reminder_deliveries where batch_id=?").get(batchId) as DeliveryRow | undefined;
}
function batchItems(batchId: string) {
  return getDb().prepare("select * from learning_reminder_items where batch_id=? order by learner_id,app_id,id")
    .all(batchId) as ItemRow[];
}

function itemCandidate(item: ItemRow) {
  return getDb().prepare(`select l.owner_parent_id parent_id,l.id learner_id,l.display_name learner_name,
    a.id app_id,a.display_name app_name,e.environment,e.state entitlement_state,e.access_until,e.effective_version
    from learners l join app_registry a on a.id=? join learner_app_effective_entitlements e
      on e.learner_id=l.id and e.app_id=a.id and e.environment='production'
    where l.id=? and l.owner_parent_id=? and e.integrity_state='healthy' and a.registry_status='active'`)
    .get(item.app_id, item.learner_id, item.parent_id) as LearnerAppCandidate | undefined;
}

function finalItems(batch: BatchRow, now: Date) {
  const included: { item: ItemRow; candidate: LearnerAppCandidate;
    eligibility: NonNullable<ReturnType<typeof candidateEligibility>> }[] = [];
  for (const item of batchItems(batch.id)) {
    try {
      const candidate = itemCandidate(item);
      const eligibility = candidate ? candidateEligibility(candidate, batch.reminder_stage, now, item.weekly_key) : null;
      if (!candidate || !eligibility) {
        getDb().prepare(`update learning_reminder_items set status='suppressed',suppressed_reason='not_currently_eligible',
          updated_at=? where id=?`).run(now.toISOString(), item.id);
        continue;
      }
      getDb().prepare(`update learning_reminder_items set status='included',observed_weekly_progress=?,
        remaining_normal_sessions=?,eligibility_version=?,eligibility_digest=?,availability_note=?,
        suppressed_reason=null,updated_at=? where id=?`).run(eligibility.observedProgress, eligibility.remaining,
          eligibility.eligibilityVersion, eligibility.eligibilityDigest, eligibility.availabilityNote,
          now.toISOString(), item.id);
      included.push({ item: { ...item, observed_weekly_progress: eligibility.observedProgress,
        remaining_normal_sessions: eligibility.remaining, availability_note: eligibility.availabilityNote },
        candidate, eligibility });
    } catch {
      getDb().prepare(`update learning_reminder_items set status='suppressed',suppressed_reason='state_unavailable',
        updated_at=? where id=?`).run(now.toISOString(), item.id);
    }
  }
  return included;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderLearningReminderEmail(items: { learnerName: string; appName: string;
  remainingNormalSessions: 1 | 2; availabilityNote?: string | null }[], dashboardUrl = "/account") {
  const safe = items.map((item) => ({ ...item, learnerName: escapeHtml(item.learnerName),
    appName: escapeHtml(item.appName), availabilityNote: item.availabilityNote ? escapeHtml(item.availabilityNote) : null }))
    .sort((left, right) => left.learnerName.localeCompare(right.learnerName)
      || left.appName.localeCompare(right.appName));
  const grouped = new Map<string, typeof safe>();
  for (const item of safe) grouped.set(item.learnerName, [...(grouped.get(item.learnerName) ?? []), item]);
  const textLines = ["Learning sessions remaining this week", ""];
  const groups = [...grouped].map(([learner, learnerItems]) => {
    textLines.push(learner);
    const rows = learnerItems.map((item) => {
      const count = `${item.remainingNormalSessions} ${item.remainingNormalSessions === 1 ? "session" : "sessions"} remaining this week`;
      textLines.push(`- ${item.appName}: ${count}`); if (item.availabilityNote) textLines.push(`  ${item.availabilityNote}`);
      return `<li style="margin:12px 0"><strong>${item.appName}</strong><br><span>${count}</span>${item.availabilityNote
        ? `<br><span style="color:#475569">${item.availabilityNote}</span>` : ""}</li>`;
    }).join("");
    textLines.push("");
    return `<section><h2 style="font-size:18px;margin:24px 0 8px">${learner}</h2><ul style="padding-left:20px">${rows}</ul></section>`;
  }).join("");
  textLines.push(`View your Babysteps account: ${dashboardUrl}`);
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
    <body style="margin:0;background:#f8fafc;color:#172033;font-family:Arial,sans-serif"><main style="max-width:600px;margin:auto;padding:24px">
    <h1 style="font-size:24px">Learning sessions remaining this week</h1><p>A gentle update for your family’s normal two-session weekly cadence.</p>
    ${groups}<p style="margin-top:28px"><a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;padding:12px 18px;background:#15803d;color:white;text-decoration:none;border-radius:8px">View Babysteps</a></p>
    <p style="font-size:13px;color:#64748b">We email you, not the learner. Session access is checked normally after sign-in.</p></main></body></html>`;
  return { subject: "Learning sessions remaining this week", text: textLines.join("\n"), html };
}

function suppressBatch(batchId: string, now: Date, reason: string) {
  getDb().prepare(`update learning_reminder_batches set status='suppressed',item_count=0,
    batch_version=batch_version+1,updated_at=? where id=?`).run(now.toISOString(), batchId);
  getDb().prepare(`update learning_reminder_items set status='suppressed',suppressed_reason=coalesce(suppressed_reason,?),
    updated_at=? where batch_id=? and status<>'suppressed'`).run(reason, now.toISOString(), batchId);
  return { status: "suppressed" as const, batchId, sent: false, itemCount: 0 };
}

function deliveryResult(batch: BatchRow, delivery: DeliveryRow) {
  const sent = ["accepted", "delivered"].includes(delivery.provider_status);
  return { status: sent ? "sent" as const : delivery.provider_status, batchId: batch.id, sent,
    itemCount: batch.item_count, providerMessageId: delivery.provider_message_id };
}

export function sendLearningReminder(input: { parentReminderBatchId: string; expectedBatchVersion: number;
  idempotencyKey: string; now?: Date; provider?: ReminderEmailProvider }) {
  assertKey(input.idempotencyKey); const now = input.now ?? new Date();
  const provider = input.provider ?? localReminderEmailProvider;
  const batch = batchRow(input.parentReminderBatchId);
  if (!batch) throw new LearningReminderError("LEARNING_REMINDER_BATCH_NOT_FOUND");
  if (batch.status === "suppressed") return { status: "suppressed" as const, batchId: batch.id,
    sent: false, itemCount: 0 };
  const requestHash = digest({ batchId: batch.id, expectedBatchVersion: input.expectedBatchVersion });
  const existingDelivery = deliveryRow(batch.id);
  if (existingDelivery) {
    if (existingDelivery.request_hash !== requestHash) throw new LearningReminderError("LEARNING_REMINDER_IDEMPOTENCY_CONFLICT");
    return deliveryResult(batch, existingDelivery);
  }
  if (batch.batch_version !== input.expectedBatchVersion || batch.status !== "ready") {
    throw new LearningReminderError("LEARNING_REMINDER_VERSION_CONFLICT");
  }
  const pref = getParentNotificationPreference(batch.parent_id, now);
  const destination = recipient(batch.parent_id);
  if (!pref.learningReminderEmailEnabled || !destination) return suppressBatch(batch.id, now, "parent_unavailable_or_disabled");
  const items = finalItems(batch, now);
  if (!items.length) return suppressBatch(batch.id, now, "no_items_after_recheck");
  const dashboardUrl = `${process.env.NEXT_PUBLIC_APP_ORIGIN ?? "http://localhost:3000"}/account`;
  const message = renderLearningReminderEmail(items.map(({ candidate, eligibility }) => ({
    learnerName: candidate.learner_name, appName: candidate.app_name,
    remainingNormalSessions: eligibility.remaining, availabilityNote: eligibility.availabilityNote,
  })), dashboardUrl);
  const providerKey = `learning-reminder:${batch.id}`;
  const providerResult = provider.send({ to: destination.email, ...message, idempotencyKey: providerKey });
  const providerStatus = providerResult.status === "failed" ? "retry_pending" : providerResult.status;
  const timestamp = now.toISOString();
  getDb().transaction(() => {
    getDb().prepare(`insert into learning_reminder_deliveries
      (id,batch_id,provider_message_id,provider_status,destination_identity_version,destination_email_hash,
       attempt_count,provider_idempotency_key,api_idempotency_key,request_hash,created_at,updated_at,sent_at,last_attempt_at)
      values(?,?,?,?,?,?,1,?,?,?,?,?,?,?)`).run(randomUUID(), batch.id, providerResult.providerMessageId ?? null,
        providerStatus, destination.identityVersion, destination.emailHash, providerKey, input.idempotencyKey,
        requestHash, timestamp, timestamp, ["accepted", "delivered"].includes(providerStatus) ? timestamp : null, timestamp);
    getDb().prepare(`update learning_reminder_batches set status=?,item_count=?,expected_parent_identity_version=?,
      batch_version=batch_version+1,updated_at=?,sent_at=? where id=?`).run(
        ["accepted", "delivered"].includes(providerStatus) ? "sent" : providerStatus === "uncertain" ? "sending" : "failed",
        items.length, destination.identityVersion, timestamp,
        ["accepted", "delivered"].includes(providerStatus) ? timestamp : null, batch.id);
  }).immediate();
  return deliveryResult(batchRow(batch.id)!, deliveryRow(batch.id)!);
}

function retryDelivery(batch: BatchRow, delivery: DeliveryRow, now: Date, provider: ReminderEmailProvider) {
  if (delivery.attempt_count >= LEARNING_REMINDER_MAX_ATTEMPTS) {
    getDb().prepare("update learning_reminder_deliveries set provider_status='failed',updated_at=? where batch_id=?")
      .run(now.toISOString(), batch.id);
    getDb().prepare("update learning_reminder_batches set status='failed',updated_at=? where id=?")
      .run(now.toISOString(), batch.id);
    return "failed" as const;
  }
  const destination = recipient(batch.parent_id);
  const pref = getParentNotificationPreference(batch.parent_id, now);
  const items = destination && pref.learningReminderEmailEnabled ? finalItems(batch, now) : [];
  if (!destination || !items.length) { suppressBatch(batch.id, now, "retry_no_longer_eligible"); return "suppressed" as const; }
  const message = renderLearningReminderEmail(items.map(({ candidate, eligibility }) => ({
    learnerName: candidate.learner_name, appName: candidate.app_name,
    remainingNormalSessions: eligibility.remaining, availabilityNote: eligibility.availabilityNote,
  })), `${process.env.NEXT_PUBLIC_APP_ORIGIN ?? "http://localhost:3000"}/account`);
  const result = provider.send({ to: destination.email, ...message, idempotencyKey: delivery.provider_idempotency_key });
  const status = result.status === "failed" ? (delivery.attempt_count + 1 >= LEARNING_REMINDER_MAX_ATTEMPTS
    ? "failed" : "retry_pending") : result.status;
  const timestamp = now.toISOString();
  getDb().prepare(`update learning_reminder_deliveries set provider_message_id=coalesce(?,provider_message_id),
    provider_status=?,destination_identity_version=?,destination_email_hash=?,attempt_count=attempt_count+1,
    updated_at=?,last_attempt_at=?,sent_at=case when ? in ('accepted','delivered') then ? else sent_at end
    where batch_id=?`).run(result.providerMessageId ?? null, status, destination.identityVersion,
      destination.emailHash, timestamp, timestamp, status, timestamp, batch.id);
  getDb().prepare(`update learning_reminder_batches set status=?,updated_at=?,sent_at=case when ? in
    ('accepted','delivered') then ? else sent_at end where id=?`).run(
      ["accepted", "delivered"].includes(status) ? "sent" : status === "uncertain" ? "sending" : "failed",
      timestamp, status, timestamp, batch.id);
  return ["accepted", "delivered"].includes(status) ? "delivered" as const
    : status === "failed" ? "failed" as const : "retried" as const;
}

export type LearningReminderReconciliationResult = { delivered: number; retried: number; failed: number;
  unchanged: number; nextCursor: string | null };

export function reconcileLearningReminderDeliveries(input: { batchId?: string | null; cursor?: string | null;
  limit?: number; runIdempotencyKey: string; principalId: string; now?: Date;
  provider?: ReminderEmailProvider }): LearningReminderReconciliationResult {
  assertKey(input.runIdempotencyKey); const now = input.now ?? new Date(); const pageLimit = limit(input.limit);
  const provider = input.provider ?? localReminderEmailProvider; const after = input.cursor ?? "";
  if (after.length > 200) throw new LearningReminderError("LEARNING_REMINDER_CURSOR_INVALID");
  const jobKey = `${input.runIdempotencyKey}:${after}:${input.batchId ?? ""}`;
  const requestHash = digest({ batchId: input.batchId ?? null, after, limit: pageLimit });
  const replay = startJob(input.principalId, "reconcile", jobKey, requestHash, now);
  if (replay) return replay as LearningReminderReconciliationResult;
  const params: unknown[] = [after]; let batchFilter = "";
  if (input.batchId) { batchFilter = " and d.batch_id=?"; params.push(input.batchId); }
  params.push(pageLimit + 1);
  const rows = getDb().prepare(`select d.* from learning_reminder_deliveries d
    where d.provider_status in ('uncertain','retry_pending') and d.batch_id>?${batchFilter}
    order by d.batch_id limit ?`).all(...params) as DeliveryRow[];
  const page = rows.slice(0, pageLimit); let delivered = 0; let retried = 0; let failed = 0; let unchanged = 0;
  for (const delivery of page) {
    const batch = batchRow(delivery.batch_id); if (!batch) { failed += 1; continue; }
    if (delivery.provider_status === "uncertain" && provider.lookup) {
      const status = provider.lookup({ providerMessageId: delivery.provider_message_id,
        idempotencyKey: delivery.provider_idempotency_key }).status;
      if (status === "delivered") {
        getDb().prepare(`update learning_reminder_deliveries set provider_status='delivered',sent_at=coalesce(sent_at,?),
          updated_at=? where batch_id=?`).run(now.toISOString(), now.toISOString(), batch.id);
        getDb().prepare(`update learning_reminder_batches set status='sent',sent_at=coalesce(sent_at,?),
          updated_at=? where id=?`).run(now.toISOString(), now.toISOString(), batch.id);
        delivered += 1; continue;
      }
      if (status === "pending") { unchanged += 1; continue; }
    }
    const outcome = retryDelivery(batch, delivery, now, provider);
    if (outcome === "delivered") delivered += 1;
    else if (outcome === "retried") retried += 1;
    else if (outcome === "failed") failed += 1;
    else unchanged += 1;
  }
  const last = page.at(-1);
  const result = { delivered, retried, failed, unchanged,
    nextCursor: rows.length > pageLimit && last ? last.batch_id : null };
  purgeLearningReminderMetadata(now, 100);
  return finishJob(input.principalId, "reconcile", jobKey, result, now) as typeof result;
}

export function purgeLearningReminderMetadata(now = new Date(), purgeLimit = 100) {
  const cutoff = new Date(now.getTime() - LEARNING_REMINDER_RETENTION_DAYS * 86_400_000).toISOString();
  const rows = getDb().prepare("select id from learning_reminder_batches where created_at<? order by created_at,id limit ?")
    .all(cutoff, limit(purgeLimit, 100)) as { id: string }[];
  const remove = getDb().prepare("delete from learning_reminder_batches where id=?");
  getDb().transaction(() => { for (const row of rows) remove.run(row.id);
    getDb().prepare("delete from learning_reminder_job_runs where created_at<?").run(cutoff); }).immediate();
  return { deletedBatches: rows.length, cutoff };
}

// PD-003 reuses cadence timing/feasibility but deliberately ignores email
// preference and delivery state. Calling this function never sends or writes.
export function listLearningCadenceAttention(parentId: string, stage: LearningReminderStage, now = new Date()) {
  return learnerAppCandidates(parentId, now).flatMap((candidate) => {
    try {
      const eligibility = candidateEligibility(candidate, stage, now);
      return eligibility ? [{ learnerId: candidate.learner_id, learnerName: candidate.learner_name,
        appId: candidate.app_id, appName: candidate.app_name, weeklyKey: eligibility.weeklyKey,
        remainingNormalSessions: eligibility.remaining, weeklyEndAt:
          readCurrentConsistency(candidate.learner_id, candidate.app_id, candidate.environment, now).currentWeekEndAt,
        availabilityNote: eligibility.availabilityNote }] : [];
    } catch { return []; }
  });
}
