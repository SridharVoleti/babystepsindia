import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { isoWeekKey } from "@/lib/learning-session/week";

export class StandardCreditError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "StandardCreditError"; }
}

type Batch = {
  id: string; learner_id: string; app_id: string; allocation_month: string | null; timezone: string | null;
  entitlement_period_id: string | null;
  granted_count: number; reserved_count: number; consumed_count: number;
  effective_at: string; expires_at: string; version: number;
};

const availableOf = (batch: Batch) => batch.granted_count - batch.reserved_count - batch.consumed_count;
const isLive = (batch: Batch | undefined, now: Date): batch is Batch =>
  !!batch && new Date(batch.expires_at).getTime() > now.getTime();

function timeZoneOffsetMinutes(timezone: string, at: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
  return (asUtc - at.getTime()) / 60_000;
}

// Local wall-clock time (no zone suffix, e.g. "2026-08-01T00:00:00.000") -> UTC instant.
function zonedTimeToUtc(timezone: string, localIso: string) {
  const naive = new Date(`${localIso}Z`);
  return new Date(naive.getTime() - timeZoneOffsetMinutes(timezone, naive) * 60_000);
}

function monthStartIso(year: number, monthIndex0: number) {
  const y = year + Math.floor(monthIndex0 / 12);
  const m = ((monthIndex0 % 12) + 12) % 12;
  return `${y}-${String(m + 1).padStart(2, "0")}-01T00:00:00.000`;
}

function currentAllocationMonth(timezone: string, now: Date) {
  return `${calendarDateInTimeZone(timezone, now).slice(0, 7)}-01`;
}

function shiftAllocationMonth(allocationMonth: string, delta: number) {
  const [year, month] = allocationMonth.split("-").map(Number);
  const iso = monthStartIso(year, month - 1 + delta);
  return iso.slice(0, 10);
}

function allocationWindow(allocationMonth: string, timezone: string) {
  const [year, month] = allocationMonth.split("-").map(Number);
  const effectiveAt = zonedTimeToUtc(timezone, monthStartIso(year, month - 1));
  const expiresAt = new Date(zonedTimeToUtc(timezone, monthStartIso(year, month - 1 + 2)).getTime() - 1);
  return { effectiveAt: effectiveAt.toISOString(), expiresAt: expiresAt.toISOString() };
}

// Lazy allocation (SC-002 business rule 8-10): creates the current month's
// eight-credit batch on first use, idempotently, preserving the true
// effective/expiry window rather than the row-creation timestamp.
export async function ensureMonthlyStandardAllocation(learnerId: string, appId: string, timezone: string, now: Date): Promise<Batch> {
  const allocationMonth = currentAllocationMonth(timezone, now);
  const db = resolveDbClient();
  const existing = await db.get<Batch>(
    "select * from learner_app_standard_credit_batches where learner_id=? and app_id=? and allocation_month=?",
    [learnerId, appId, allocationMonth]);
  if (existing) return existing;
  const { effectiveAt, expiresAt } = allocationWindow(allocationMonth, timezone);
  const id = randomUUID();
  const timestamp = now.toISOString();
  try {
    await db.run(`insert into learner_app_standard_credit_batches(id,learner_id,app_id,allocation_month,timezone,
      granted_count,reserved_count,consumed_count,effective_at,expires_at,version,created_at,updated_at)
      values(?,?,?,?,?,8,0,0,?,?,1,?,?)`,
      [id, learnerId, appId, allocationMonth, timezone, effectiveAt, expiresAt, timestamp, timestamp]);
  } catch {
    // unique(learner_id,app_id,allocation_month): a concurrent caller won the race.
    return (await db.get<Batch>(
      "select * from learner_app_standard_credit_batches where learner_id=? and app_id=? and allocation_month=?",
      [learnerId, appId, allocationMonth]))!;
  }
  return (await db.get<Batch>("select * from learner_app_standard_credit_batches where id=?", [id]))!;
}

// EN-001 business rules 15-24, 51-53: one independent 8-credit batch per
// allocation-bearing entitlement app-period, atomic with the period's
// creation. Reuses the exact same compact-batch shape/idempotency approach
// as ensureMonthlyStandardAllocation, just keyed by entitlement_period_id
// instead of a calendar month — this does NOT feed into liveBatches/
// fundStandardSession/buildStandardAllowance (those remain calendar-month
// scoped); wiring entitlement-period batches into live standard_monthly
// session funding is a deliberately separate, deferred decision (see
// EN-001/EN-002 handoff notes) mirroring the existing unresolved
// normal/standard_monthly coexistence question.
export async function ensureEntitlementPeriodStandardAllocation(learnerId: string, appId: string,
  entitlementPeriodId: string, effectiveAt: string, expiresAt: string, now: Date): Promise<Batch> {
  const db = resolveDbClient();
  const existing = await db.get<Batch>(
    "select * from learner_app_standard_credit_batches where entitlement_period_id=?", [entitlementPeriodId]);
  if (existing) return existing;
  const id = randomUUID();
  const timestamp = now.toISOString();
  try {
    await db.run(`insert into learner_app_standard_credit_batches(id,learner_id,app_id,entitlement_period_id,
      granted_count,reserved_count,consumed_count,effective_at,expires_at,version,created_at,updated_at)
      values(?,?,?,?,8,0,0,?,?,1,?,?)`,
      [id, learnerId, appId, entitlementPeriodId, effectiveAt, expiresAt, timestamp, timestamp]);
  } catch {
    // unique(entitlement_period_id): a concurrent caller won the race.
    return (await db.get<Batch>("select * from learner_app_standard_credit_batches where entitlement_period_id=?",
      [entitlementPeriodId]))!;
  }
  return (await db.get<Batch>("select * from learner_app_standard_credit_batches where id=?", [id]))!;
}

async function liveBatches(learnerId: string, appId: string, timezone: string, now: Date) {
  const db = resolveDbClient();
  const current = await ensureMonthlyStandardAllocation(learnerId, appId, timezone, now);
  const previousMonth = shiftAllocationMonth(currentAllocationMonth(timezone, now), -1);
  const previous = await db.get<Batch>(
    "select * from learner_app_standard_credit_batches where learner_id=? and app_id=? and allocation_month=?",
    [learnerId, appId, previousMonth]);
  return [previous, current].filter((b): b is Batch => isLive(b, now))
    .sort((a, b) => a.expires_at.localeCompare(b.expires_at)); // earliest-expiry-first
}

export async function buildStandardAllowance(learnerId: string, appId: string, timezone: string, now: Date,
  unlimited = false) {
  const db = resolveDbClient();
  const batches = await liveBatches(learnerId, appId, timezone, now);
  const availableCount = batches.reduce((sum, b) => sum + Math.max(0, availableOf(b)), 0);
  const expiringThisMonth = batches.find((b) => b.allocation_month === shiftAllocationMonth(currentAllocationMonth(timezone, now), -1));
  const expiringThisMonthCount = expiringThisMonth ? Math.max(0, availableOf(expiringThisMonth)) : 0;
  const withCredit = batches.filter((b) => availableOf(b) > 0);
  const nearestExpiryDate = withCredit[0]?.expires_at.slice(0, 10) ?? null;
  const weekKey = isoWeekKey(now, timezone);
  const usage = await db.get<{ standard_sessions_funded: number }>(
    "select standard_sessions_funded from learner_app_week_usage where learner_id=? and app_id=? and week_key=?",
    [learnerId, appId, weekKey]);
  const standardSessionsUsedThisWeek = usage?.standard_sessions_funded ?? 0;
  const catchUpEligible = standardSessionsUsedThisWeek === 2 && availableCount > 8 && expiringThisMonthCount > 0;
  // LP-004: admin-controlled exemption — see supabase/migrations/0081_....
  // Number.MAX_SAFE_INTEGER (not Infinity: this crosses the wire as JSON,
  // where Infinity serializes to null) so standardSessionsUsedThisWeek can
  // never reach the limit.
  return {
    availableCount, expiringThisMonthCount, nearestExpiryDate, standardSessionsUsedThisWeek,
    standardWeeklyLimit: unlimited ? Number.MAX_SAFE_INTEGER : catchUpEligible ? 3 : 2, catchUpEligible,
  };
}

// SC-002 business rules 19-26, 41: the RESERVE half of the SC-003
// reserve-then-consume lifecycle. Locks nothing extra beyond the enclosing
// caller's transaction/single-active-session invariant (LP-004 guarantees
// only one starting/active/disconnected session exists per learner).
export async function fundStandardSession(input: { learnerId: string; appId: string; timezone: string; now: Date;
  unlimited?: boolean }) {
  const db = resolveDbClient();
  const weekKey = isoWeekKey(input.now, input.timezone);
  await db.run(`insert into learner_app_week_usage(learner_id,app_id,week_key,week_timezone,normal_sessions_started,
    standard_sessions_funded,updated_at) values(?,?,?,?,0,0,?) on conflict(learner_id,app_id,week_key) do nothing`,
    [input.learnerId, input.appId, weekKey, input.timezone, input.now.toISOString()]);
  const usage = (await db.get<{ standard_sessions_funded: number }>(
    "select standard_sessions_funded from learner_app_week_usage where learner_id=? and app_id=? and week_key=?",
    [input.learnerId, input.appId, weekKey]))!;
  const funded = usage.standard_sessions_funded;
  // LP-004: admin-controlled exemption — see supabase/migrations/0081_....
  if (!input.unlimited && funded >= 3) throw new StandardCreditError("WEEKLY_STANDARD_SESSION_LIMIT_REACHED");
  const batches = await liveBatches(input.learnerId, input.appId, input.timezone, input.now);
  if (!input.unlimited && funded >= 2) {
    const availableCount = batches.reduce((sum, b) => sum + Math.max(0, availableOf(b)), 0);
    const previousMonth = shiftAllocationMonth(currentAllocationMonth(input.timezone, input.now), -1);
    const expiring = batches.find((b) => b.allocation_month === previousMonth);
    const expiringThisMonthCount = expiring ? Math.max(0, availableOf(expiring)) : 0;
    if (!(availableCount > 8 && expiringThisMonthCount > 0)) throw new StandardCreditError("WEEKLY_STANDARD_SESSION_LIMIT_REACHED");
  }
  const batch = batches.find((b) => availableOf(b) > 0);
  if (!batch) throw new StandardCreditError("STANDARD_SESSION_CREDIT_UNAVAILABLE");
  await db.run(`update learner_app_standard_credit_batches set reserved_count=reserved_count+1,version=version+1,
    updated_at=? where id=?`, [input.now.toISOString(), batch.id]);
  return { batchId: batch.id, weeklySessionOrdinal: funded + 1, weekKey };
}

// SC-002 business rule 45: the CONSUME half, triggered only by a genuinely
// new SC-001 usable-launch establishment (never on an idempotent replay —
// see establishUsableLaunch's alreadyEstablished flag).
export async function consumeStandardReservation(batchId: string, learnerId: string, appId: string, weekKey: string, now: Date) {
  return resolveDbClient().transaction(async (db) => {
    const batch = await db.get<Batch>("select * from learner_app_standard_credit_batches where id=?", [batchId]);
    if (!batch || batch.learner_id !== learnerId || batch.app_id !== appId) {
      throw new StandardCreditError("STANDARD_SESSION_CREDIT_BINDING_MISMATCH");
    }
    if (batch.reserved_count <= 0) throw new StandardCreditError("STANDARD_SESSION_CREDIT_NOT_RESERVED");
    await db.run(`update learner_app_standard_credit_batches set reserved_count=reserved_count-1,
      consumed_count=consumed_count+1,version=version+1,updated_at=? where id=?`, [now.toISOString(), batchId]);
    await db.run(`update learner_app_week_usage set standard_sessions_funded=standard_sessions_funded+1,
      version=version+1,updated_at=? where learner_id=? and app_id=? and week_key=?`,
      [now.toISOString(), learnerId, appId, weekKey]);
  });
}

// Testing-only escape hatch: zero out a learner's weekly *standard-credit*
// session counter across every app/week row so QA can retest the standard
// weekly-limit flow without waiting for the ISO week to roll over.
//
// Deliberately does NOT touch normal_sessions_started: that counter mirrors
// real rows in learner_sessions, gated by the partial unique index
// idx_learner_sessions_normal_slot on (learner_id, app_id, week_key,
// weekly_slot_number) where source='normal'. Zeroing the counter without
// removing those historical rows lets a later Start recompute a
// already-taken slot number and crash the insert with a raw 23505 constraint
// violation (surfaces to the client as SESSION_LIFECYCLE_FAILED) instead of
// the clean WEEKLY_SESSION_LIMIT_REACHED error. There is no safe way to
// reset that cap short of deleting the underlying session rows, which risks
// orphaning the many tables with a foreign key to learner_sessions(id).
export async function resetWeeklyUsageForTesting(learnerId: string, now: Date) {
  const db = resolveDbClient();
  await db.run(`update learner_app_week_usage set standard_sessions_funded=0,
    version=version+1, updated_at=? where learner_id=?`, [now.toISOString(), learnerId]);
}

// SC-002 business rule 44/46: a pre-usable-launch failure/timeout releases
// the reservation — expired-during-hold units are not restored available.
export async function releaseStandardReservation(batchId: string, now: Date) {
  const db = resolveDbClient();
  const batch = await db.get<Batch>("select * from learner_app_standard_credit_batches where id=?", [batchId]);
  if (!batch || batch.reserved_count <= 0) return false;
  await db.run(`update learner_app_standard_credit_batches set reserved_count=reserved_count-1,version=version+1,
    updated_at=? where id=?`, [now.toISOString(), batchId]);
  return isLive(batch, now);
}
