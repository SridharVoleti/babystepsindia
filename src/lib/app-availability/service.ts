import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";

export const SAFE_START_SECONDS = 3_900;
export const MAINTENANCE_NOTICE_SECONDS = 24 * 60 * 60;

export type AppEnvironment = "development" | "staging" | "production";
export type AuthoritativeAvailabilityState =
  | "available"
  | "maintenance"
  | "temporarily_unavailable"
  | "restoring"
  | "security_blocked";
export type OperationalAvailability =
  | "available"
  | "maintenance_soon"
  | "temporarily_unavailable"
  | "restoring"
  | "security_blocked"
  | "unknown";

type AvailabilityRow = {
  app_id: string; environment: AppEnvironment; operational_state: AuthoritativeAvailabilityState;
  availability_version: number; reason_category: string | null; safe_learner_message: string | null;
  expected_return_at: string | null; source_reference: string | null; updated_by: string;
  updated_by_type: string; updated_at: string;
};
type WindowRow = {
  id: string; app_id: string; environment: AppEnvironment; starts_at: string; ends_at: string;
  status: "scheduled" | "cancelled" | "completed"; reason_category: string;
  safe_learner_message: string | null; window_version: number; created_by: string;
  updated_by: string; created_at: string; updated_at: string;
};

export type AvailabilityView = {
  appId: string;
  environment: AppEnvironment;
  authoritativeState: AuthoritativeAvailabilityState;
  operationalAvailability: OperationalAvailability;
  availabilityVersion: number;
  reasonCategory: string | null;
  learnerMessage: string | null;
  nextMaintenanceWindowId: string | null;
  nextMaintenanceStartAt: string | null;
  maintenanceEndsAt: string | null;
  safeStartUntil: string | null;
  expectedReturnAt: string | null;
  startBlocked: boolean;
};

export class AppAvailabilityError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "AppAvailabilityError"; }
}

const STATUS_BY_CODE: Record<string, number> = {
  APP_NOT_FOUND: 404,
  APP_AVAILABILITY_UNKNOWN: 409,
  APP_AVAILABILITY_VERSION_CONFLICT: 409,
  MAINTENANCE_WINDOW_NOT_FOUND: 404,
  MAINTENANCE_WINDOW_CONFLICT: 409,
  MAINTENANCE_WINDOW_INVALID: 422,
  APP_AVAILABILITY_MESSAGE_INVALID: 422,
  APP_AVAILABILITY_STATE_INVALID: 422,
  IDEMPOTENCY_KEY_REUSED: 409,
  MUTATION_IN_PROGRESS: 409,
  APP_MAINTENANCE_SOON: 409,
  APP_TEMPORARILY_UNAVAILABLE: 409,
  APP_RESTORING: 409,
  APP_SECURITY_BLOCKED: 409,
};
export function appAvailabilityErrorStatus(code: string) { return STATUS_BY_CODE[code] ?? 400; }

function assertEnvironment(value: string): asserts value is AppEnvironment {
  if (!["development", "staging", "production"].includes(value)) {
    throw new AppAvailabilityError("APP_AVAILABILITY_STATE_INVALID");
  }
}

function safeMessage(value: string | null | undefined) {
  if (value === null || value === undefined || value.trim() === "") return null;
  const normalized = value.trim();
  if (normalized.length > 160 || /[<>\u0000-\u001f]/.test(normalized)
    || /\b(password|secret|token|credential|provider incident|security incident)\b/i.test(normalized)) {
    throw new AppAvailabilityError("APP_AVAILABILITY_MESSAGE_INVALID");
  }
  return normalized;
}

function requestHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function availabilityRow(appId: string, environment: AppEnvironment) {
  return getDb().prepare("select * from app_launch_availability where app_id=? and environment=?")
    .get(appId, environment) as AvailabilityRow | undefined;
}

function windowRow(windowId: string) {
  return getDb().prepare("select * from app_maintenance_windows where id=?").get(windowId) as WindowRow | undefined;
}

function relevantWindow(appId: string, environment: AppEnvironment, now: Date) {
  return getDb().prepare(`select * from app_maintenance_windows
    where app_id=? and environment=? and status='scheduled' and ends_at>?
    order by starts_at,id limit 1`).get(appId, environment, now.toISOString()) as WindowRow | undefined;
}

function toWindowView(row: WindowRow) {
  return { id: row.id, appId: row.app_id, environment: row.environment, startsAt: row.starts_at,
    endsAt: row.ends_at, status: row.status, reasonCategory: row.reason_category,
    learnerMessage: row.safe_learner_message, windowVersion: row.window_version,
    createdAt: row.created_at, updatedAt: row.updated_at };
}

export function readAppAvailability(appId: string, environmentValue: string, now: Date): AvailabilityView {
  assertEnvironment(environmentValue);
  const row = availabilityRow(appId, environmentValue);
  if (!row) throw new AppAvailabilityError("APP_AVAILABILITY_UNKNOWN");
  const window = relevantWindow(appId, environmentValue, now);
  const startsAt = window ? new Date(window.starts_at) : null;
  const endsAt = window ? new Date(window.ends_at) : null;
  const safeStartUntil = startsAt ? new Date(startsAt.getTime() - SAFE_START_SECONDS * 1000) : null;
  const activeWindow = !!(startsAt && endsAt && now >= startsAt && now < endsAt);
  const insideNotice = !!(startsAt && startsAt.getTime() - now.getTime() <= MAINTENANCE_NOTICE_SECONDS * 1000);
  const unsafeToStart = !!(safeStartUntil && now > safeStartUntil);

  let operationalAvailability: OperationalAvailability = "available";
  let startBlocked = false;
  if (row.operational_state === "security_blocked") {
    operationalAvailability = "security_blocked"; startBlocked = true;
  } else if (row.operational_state === "temporarily_unavailable") {
    operationalAvailability = "temporarily_unavailable"; startBlocked = true;
  } else if (row.operational_state === "restoring") {
    operationalAvailability = "restoring"; startBlocked = true;
  } else if (row.operational_state === "maintenance" || activeWindow) {
    operationalAvailability = "temporarily_unavailable"; startBlocked = true;
  } else if (window && (insideNotice || unsafeToStart)) {
    operationalAvailability = "maintenance_soon"; startBlocked = unsafeToStart;
  }

  return {
    appId, environment: environmentValue, authoritativeState: row.operational_state,
    operationalAvailability, availabilityVersion: row.availability_version,
    reasonCategory: window ? window.reason_category : row.reason_category,
    learnerMessage: window ? window.safe_learner_message : row.safe_learner_message,
    nextMaintenanceWindowId: window?.id ?? null, nextMaintenanceStartAt: window?.starts_at ?? null,
    maintenanceEndsAt: window?.ends_at ?? null, safeStartUntil: safeStartUntil?.toISOString() ?? null,
    expectedReturnAt: window?.ends_at ?? row.expected_return_at,
    startBlocked,
  };
}

export function readAdminAvailability(appId: string, environment: string, now: Date) {
  const current = readAppAvailability(appId, environment, now);
  const windows = getDb().prepare(`select * from app_maintenance_windows where app_id=? and environment=?
    order by starts_at desc,id desc`).all(appId, environment) as WindowRow[];
  const overlap = getDb().prepare(`select count(*) count from learner_sessions where app_id=?
    and deployment_environment=? and status in ('starting','active','disconnected','resumable')`)
    .get(appId, environment) as { count: number };
  return { ...current, windows: windows.map(toWindowView), activeSessionOverlapCount: overlap.count };
}

function checkReceipt<T>(appId: string, environment: AppEnvironment, idempotencyKey: string, hash: string): T | null {
  if (!idempotencyKey || idempotencyKey.length > 160) throw new AppAvailabilityError("IDEMPOTENCY_KEY_REUSED");
  const existing = getDb().prepare(`select request_hash,status,response_json from app_availability_mutation_receipts
    where app_id=? and environment=? and idempotency_key=?`).get(appId, environment, idempotencyKey) as
    { request_hash: string; status: string; response_json: string | null } | undefined;
  if (!existing) return null;
  if (existing.request_hash !== hash) throw new AppAvailabilityError("IDEMPOTENCY_KEY_REUSED");
  if (existing.status !== "completed" || !existing.response_json) throw new AppAvailabilityError("MUTATION_IN_PROGRESS");
  return JSON.parse(existing.response_json) as T;
}

function beginReceipt(input: { appId: string; environment: AppEnvironment; action: string; windowId?: string | null;
  targetState?: string | null; availabilityVersion: number; requestHash: string; idempotencyKey: string; actorId: string; now: Date }) {
  getDb().prepare(`insert into app_availability_mutation_receipts
    (app_id,environment,action,window_id,target_state,availability_version_from,request_hash,idempotency_key,status,actor_id,created_at)
    values(?,?,?,?,?,?,?,?, 'processing',?,?)`).run(input.appId, input.environment, input.action,
      input.windowId ?? null, input.targetState ?? null, input.availabilityVersion, input.requestHash,
      input.idempotencyKey, input.actorId, input.now.toISOString());
}

function completeReceipt(input: { appId: string; environment: AppEnvironment; idempotencyKey: string;
  availabilityVersion: number; response: unknown; now: Date }) {
  getDb().prepare(`update app_availability_mutation_receipts set availability_version_to=?,status='completed',
    response_json=?,completed_at=? where app_id=? and environment=? and idempotency_key=?`)
    .run(input.availabilityVersion, JSON.stringify(input.response), input.now.toISOString(),
      input.appId, input.environment, input.idempotencyKey);
}

function emitAvailabilityEvent(appId: string, environment: AppEnvironment, availabilityVersion: number,
  eventType: string, now: Date) {
  getDb().prepare(`insert into app_availability_events
    (id,app_id,environment,availability_version,event_type,created_at) values(?,?,?,?,?,?)`)
    .run(randomUUID(), appId, environment, availabilityVersion, eventType, now.toISOString());
}

function assertVersion(row: AvailabilityRow | undefined, expectedVersion: number) {
  if (!row) throw new AppAvailabilityError("APP_AVAILABILITY_UNKNOWN");
  if (row.availability_version !== expectedVersion) {
    throw new AppAvailabilityError("APP_AVAILABILITY_VERSION_CONFLICT");
  }
}

export type ScheduleMaintenanceInput = { appId: string; environment: AppEnvironment; startsAt: Date; endsAt: Date;
  reasonCategory: string; learnerMessage?: string | null; expectedAvailabilityVersion: number;
  idempotencyKey: string; actorId: string };

export function scheduleMaintenanceWindow(input: ScheduleMaintenanceInput, now: Date) {
  assertEnvironment(input.environment);
  if (!input.reasonCategory || input.reasonCategory.length > 80 || input.endsAt <= input.startsAt) {
    throw new AppAvailabilityError("MAINTENANCE_WINDOW_INVALID");
  }
  const message = safeMessage(input.learnerMessage);
  const canonical = { action: "schedule", appId: input.appId, environment: input.environment,
    startsAt: input.startsAt.toISOString(), endsAt: input.endsAt.toISOString(),
    reasonCategory: input.reasonCategory, learnerMessage: message,
    expectedAvailabilityVersion: input.expectedAvailabilityVersion };
  const hash = requestHash(canonical);
  const cached = checkReceipt<ReturnType<typeof readAdminAvailability>>(input.appId, input.environment,
    input.idempotencyKey, hash);
  if (cached) return cached;
  const db = getDb();
  return db.transaction(() => {
    const current = availabilityRow(input.appId, input.environment);
    assertVersion(current, input.expectedAvailabilityVersion);
    const conflict = db.prepare(`select 1 from app_maintenance_windows where app_id=? and environment=?
      and status='scheduled' and starts_at<? and ends_at>? limit 1`)
      .get(input.appId, input.environment, input.endsAt.toISOString(), input.startsAt.toISOString());
    if (conflict) throw new AppAvailabilityError("MAINTENANCE_WINDOW_CONFLICT");
    beginReceipt({ appId: input.appId, environment: input.environment, action: "schedule", availabilityVersion: current!.availability_version,
      requestHash: hash, idempotencyKey: input.idempotencyKey, actorId: input.actorId, now });
    const id = randomUUID();
    db.prepare(`insert into app_maintenance_windows
      (id,app_id,environment,starts_at,ends_at,status,reason_category,safe_learner_message,window_version,
       created_by,updated_by,created_at,updated_at) values(?,?,?,?,?,'scheduled',?,?,1,?,?,?,?)`)
      .run(id, input.appId, input.environment, input.startsAt.toISOString(), input.endsAt.toISOString(),
        input.reasonCategory, message, input.actorId, input.actorId, now.toISOString(), now.toISOString());
    db.prepare(`update app_launch_availability set availability_version=availability_version+1,
      updated_by=?,updated_by_type='administrator',updated_at=? where app_id=? and environment=?`)
      .run(input.actorId, now.toISOString(), input.appId, input.environment);
    const version = current!.availability_version + 1;
    emitAvailabilityEvent(input.appId, input.environment, version, "maintenance_window_scheduled", now);
    const result = readAdminAvailability(input.appId, input.environment, now);
    completeReceipt({ appId: input.appId, environment: input.environment, idempotencyKey: input.idempotencyKey,
      availabilityVersion: version, response: result, now });
    return result;
  }).immediate();
}

export type UpdateMaintenanceInput = { appId: string; environment: AppEnvironment; windowId: string;
  action: "update" | "cancel"; startsAt?: Date; endsAt?: Date; reasonCategory?: string;
  learnerMessage?: string | null; expectedAvailabilityVersion: number; expectedWindowVersion: number;
  idempotencyKey: string; actorId: string };

export function updateMaintenanceWindow(input: UpdateMaintenanceInput, now: Date) {
  assertEnvironment(input.environment);
  const existing = windowRow(input.windowId);
  if (!existing || existing.app_id !== input.appId || existing.environment !== input.environment) {
    throw new AppAvailabilityError("MAINTENANCE_WINDOW_NOT_FOUND");
  }
  const startsAt = input.startsAt ?? new Date(existing.starts_at);
  const endsAt = input.endsAt ?? new Date(existing.ends_at);
  if (input.action === "update" && (endsAt <= startsAt || !input.reasonCategory && !existing.reason_category)) {
    throw new AppAvailabilityError("MAINTENANCE_WINDOW_INVALID");
  }
  const message = input.learnerMessage === undefined ? existing.safe_learner_message : safeMessage(input.learnerMessage);
  const canonical = { action: input.action, appId: input.appId, environment: input.environment,
    windowId: input.windowId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
    reasonCategory: input.reasonCategory ?? existing.reason_category, learnerMessage: message,
    expectedAvailabilityVersion: input.expectedAvailabilityVersion, expectedWindowVersion: input.expectedWindowVersion };
  const hash = requestHash(canonical);
  const cached = checkReceipt<ReturnType<typeof readAdminAvailability>>(input.appId, input.environment,
    input.idempotencyKey, hash);
  if (cached) return cached;
  const db = getDb();
  return db.transaction(() => {
    const current = availabilityRow(input.appId, input.environment);
    assertVersion(current, input.expectedAvailabilityVersion);
    const fresh = windowRow(input.windowId);
    if (!fresh || fresh.status !== "scheduled") throw new AppAvailabilityError("MAINTENANCE_WINDOW_NOT_FOUND");
    if (fresh.window_version !== input.expectedWindowVersion) throw new AppAvailabilityError("APP_AVAILABILITY_VERSION_CONFLICT");
    if (input.action === "update") {
      const conflict = db.prepare(`select 1 from app_maintenance_windows where app_id=? and environment=?
        and id<>? and status='scheduled' and starts_at<? and ends_at>? limit 1`)
        .get(input.appId, input.environment, input.windowId, endsAt.toISOString(), startsAt.toISOString());
      if (conflict) throw new AppAvailabilityError("MAINTENANCE_WINDOW_CONFLICT");
    }
    beginReceipt({ appId: input.appId, environment: input.environment, action: input.action,
      windowId: input.windowId, availabilityVersion: current!.availability_version,
      requestHash: hash, idempotencyKey: input.idempotencyKey, actorId: input.actorId, now });
    if (input.action === "cancel") {
      db.prepare(`update app_maintenance_windows set status='cancelled',window_version=window_version+1,
        updated_by=?,updated_at=? where id=? and window_version=?`)
        .run(input.actorId, now.toISOString(), input.windowId, input.expectedWindowVersion);
    } else {
      db.prepare(`update app_maintenance_windows set starts_at=?,ends_at=?,reason_category=?,safe_learner_message=?,
        window_version=window_version+1,updated_by=?,updated_at=? where id=? and window_version=?`)
        .run(startsAt.toISOString(), endsAt.toISOString(), input.reasonCategory ?? existing.reason_category,
          message, input.actorId, now.toISOString(), input.windowId, input.expectedWindowVersion);
    }
    db.prepare(`update app_launch_availability set availability_version=availability_version+1,
      updated_by=?,updated_by_type='administrator',updated_at=? where app_id=? and environment=?`)
      .run(input.actorId, now.toISOString(), input.appId, input.environment);
    const version = current!.availability_version + 1;
    emitAvailabilityEvent(input.appId, input.environment, version,
      input.action === "cancel" ? "maintenance_window_cancelled" : "maintenance_window_updated", now);
    const result = readAdminAvailability(input.appId, input.environment, now);
    completeReceipt({ appId: input.appId, environment: input.environment, idempotencyKey: input.idempotencyKey,
      availabilityVersion: version, response: result, now });
    return result;
  }).immediate();
}

export type TransitionAvailabilityInput = { appId: string; environment: AppEnvironment;
  targetState: "available" | "temporarily_unavailable" | "restoring";
  reasonCategory: string; learnerMessage?: string | null; expectedReturnAt?: Date | null;
  expectedAvailabilityVersion: number; idempotencyKey: string; actorId: string };

export function transitionAvailability(input: TransitionAvailabilityInput, now: Date) {
  assertEnvironment(input.environment);
  if (!input.reasonCategory || input.reasonCategory.length > 80) throw new AppAvailabilityError("APP_AVAILABILITY_STATE_INVALID");
  const message = safeMessage(input.learnerMessage);
  const canonical = { ...input, learnerMessage: message,
    expectedReturnAt: input.expectedReturnAt?.toISOString() ?? null };
  const hash = requestHash(canonical);
  const cached = checkReceipt<AvailabilityView>(input.appId, input.environment, input.idempotencyKey, hash);
  if (cached) return cached;
  const db = getDb();
  return db.transaction(() => {
    const current = availabilityRow(input.appId, input.environment);
    assertVersion(current, input.expectedAvailabilityVersion);
    if (current!.operational_state === "security_blocked") throw new AppAvailabilityError("APP_SECURITY_BLOCKED");
    beginReceipt({ appId: input.appId, environment: input.environment, action: "transition",
      targetState: input.targetState, availabilityVersion: current!.availability_version,
      requestHash: hash, idempotencyKey: input.idempotencyKey, actorId: input.actorId, now });
    db.prepare(`update app_launch_availability set operational_state=?,reason_category=?,safe_learner_message=?,
      expected_return_at=?,availability_version=availability_version+1,updated_by=?,updated_by_type='administrator',
      updated_at=? where app_id=? and environment=? and availability_version=?`)
      .run(input.targetState, input.reasonCategory, message, input.expectedReturnAt?.toISOString() ?? null,
        input.actorId, now.toISOString(), input.appId, input.environment, input.expectedAvailabilityVersion);
    const version = current!.availability_version + 1;
    emitAvailabilityEvent(input.appId, input.environment, version, "availability_transitioned", now);
    const result = readAppAvailability(input.appId, input.environment, now);
    completeReceipt({ appId: input.appId, environment: input.environment, idempotencyKey: input.idempotencyKey,
      availabilityVersion: version, response: result, now });
    return result;
  }).immediate();
}

export function setSecurityAvailability(input: { appId: string; environment: AppEnvironment; blocked: boolean;
  expectedAvailabilityVersion: number; sourceReference: string; securityPrincipalId: string }, now: Date) {
  assertEnvironment(input.environment);
  const db = getDb();
  return db.transaction(() => {
    const current = availabilityRow(input.appId, input.environment);
    assertVersion(current, input.expectedAvailabilityVersion);
    const state = input.blocked ? "security_blocked" : "available";
    db.prepare(`update app_launch_availability set operational_state=?,reason_category='security',
      safe_learner_message=null,expected_return_at=null,source_reference=?,availability_version=availability_version+1,
      updated_by=?,updated_by_type='security',updated_at=? where app_id=? and environment=? and availability_version=?`)
      .run(state, input.sourceReference, input.securityPrincipalId, now.toISOString(), input.appId,
        input.environment, input.expectedAvailabilityVersion);
    emitAvailabilityEvent(input.appId, input.environment, input.expectedAvailabilityVersion + 1,
      input.blocked ? "security_blocked" : "security_block_cleared", now);
    return readAppAvailability(input.appId, input.environment, now);
  }).immediate();
}

export function assertStartAvailability(appId: string, environment: string, now: Date) {
  let view: AvailabilityView;
  try { view = readAppAvailability(appId, environment, now); }
  catch (error) {
    if (error instanceof AppAvailabilityError) throw error;
    throw new AppAvailabilityError("APP_AVAILABILITY_UNKNOWN");
  }
  if (!view.startBlocked) return view;
  const code = view.operationalAvailability === "maintenance_soon" ? "APP_MAINTENANCE_SOON"
    : view.operationalAvailability === "restoring" ? "APP_RESTORING"
    : view.operationalAvailability === "security_blocked" ? "APP_SECURITY_BLOCKED"
    : view.operationalAvailability === "unknown" ? "APP_AVAILABILITY_UNKNOWN"
    : "APP_TEMPORARILY_UNAVAILABLE";
  throw new AppAvailabilityError(code);
}
