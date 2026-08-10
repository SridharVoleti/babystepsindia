import { randomUUID, createHash } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { findGraceCoverage } from "@/lib/billing/grace-policy";
import { expireDueCancellationForLearnerApp } from "@/lib/billing/cancellation-policy";

export class EntitlementAccessError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "EntitlementAccessError"; }
}

export type EffectiveSourceRole = "allocation_bearing" | "access_supporting" | "overlap_suppressed";

type PeriodRow = {
  id: string; app_id: string; learner_id: string;
  period_start: string; period_end: string; created_at: string; effective_source_role: EffectiveSourceRole;
};

export type AccessDecision = {
  allowed: boolean;
  state: "active" | "grace" | "inactive";
  appId: string;
  accessUntil: string | null;
  effectiveEntitlementId: string | null;
  effectiveEntitlementVersion: number | null;
  allocationSourceState: EffectiveSourceRole | null;
  coveringPeriodId: string | null;
};

// EN-002 business rules 33-42: recomputes the allocation-bearing/
// access-supporting role for every entitlement period this learner has for
// this app (not just a newly-added one), and materializes one effective
// row per learner+app+environment with a version that bumps whenever the
// underlying (period,role) set changes. Periods themselves carry no
// environment (a paid cycle isn't environment-scoped; only the derived
// decision is, matching how deployment/session context already uses
// "environment" elsewhere in this codebase). Called by EN-001 synchronously
// inside its own transaction whenever a period is created — this is the
// eager "keep materialized state in sync at write time" half of freshness;
// evaluateAccessFresh below re-checks the time-dependent half live.
export function recomputeEffectiveEntitlement(input: {
  learnerId: string; appId: string; environment: string; now: Date;
}): { effectiveEntitlementId: string; roleById: Map<string, EffectiveSourceRole> } {
  const db = getDb();
  const periods = db.prepare(
    `select id,app_id,learner_id,period_start,period_end,created_at,effective_source_role
     from learner_app_entitlement_periods where learner_id=? and app_id=?`,
  ).all(input.learnerId, input.appId) as PeriodRow[];
  const sorted = [...periods].sort((a, b) =>
    a.period_start.localeCompare(b.period_start) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));

  // Greedy earliest-first walk (rule 34/39-40): the earliest period is
  // allocation-bearing; a later period that starts before the current
  // allocation-bearing period ends is access-supporting (overlap); a later
  // period starting at/after that boundary becomes the new
  // allocation-bearing source at its own non-overlapping cycle boundary.
  let allocationBearingEnd: string | null = null;
  const roleById = new Map<string, EffectiveSourceRole>();
  for (const p of sorted) {
    if (allocationBearingEnd === null || p.period_start >= allocationBearingEnd) {
      roleById.set(p.id, "allocation_bearing");
      allocationBearingEnd = p.period_end;
    } else {
      roleById.set(p.id, "access_supporting");
    }
  }

  const nowIso = input.now.toISOString();
  for (const p of sorted) {
    const role = roleById.get(p.id)!;
    if (role !== p.effective_source_role) {
      db.prepare("update learner_app_entitlement_periods set effective_source_role=? where id=?").run(role, p.id);
    }
  }

  const covering = sorted.find((p) => p.period_start <= nowIso && nowIso < p.period_end);
  const valid = sorted.filter((p) => p.period_end > nowIso);
  const accessUntil = valid.length
    ? valid.reduce((max, p) => (p.period_end > max ? p.period_end : max), valid[0].period_end)
    : null;
  const state = covering ? "active" : "inactive";
  const allocationSourcePeriodId = covering && roleById.get(covering.id) === "allocation_bearing" ? covering.id : null;
  const sourceSetHash = createHash("sha256")
    .update(JSON.stringify(sorted.map((p) => [p.id, roleById.get(p.id)]))).digest("hex");

  const existing = db.prepare(
    "select id,effective_version,source_set_hash from learner_app_effective_entitlements where learner_id=? and app_id=? and environment=?",
  ).get(input.learnerId, input.appId, input.environment) as
    { id: string; effective_version: number; source_set_hash: string } | undefined;

  let effectiveEntitlementId: string;
  if (!existing) {
    effectiveEntitlementId = randomUUID();
    db.prepare(
      `insert into learner_app_effective_entitlements(id,learner_id,app_id,environment,state,
       allocation_source_entitlement_period_id,access_until,effective_version,source_set_hash,created_at,updated_at)
       values(?,?,?,?,?,?,?,1,?,?,?)`,
    ).run(effectiveEntitlementId, input.learnerId, input.appId, input.environment, state,
      allocationSourcePeriodId, accessUntil, sourceSetHash, nowIso, nowIso);
  } else {
    effectiveEntitlementId = existing.id;
    const versionBump = existing.source_set_hash === sourceSetHash ? 0 : 1;
    db.prepare(
      `update learner_app_effective_entitlements set state=?,allocation_source_entitlement_period_id=?,
       access_until=?,source_set_hash=?,effective_version=effective_version+?,updated_at=? where id=?`,
    ).run(state, allocationSourcePeriodId, accessUntil, sourceSetHash, versionBump, nowIso, effectiveEntitlementId);
  }

  db.prepare("delete from learner_app_effective_sources where effective_entitlement_id=?").run(effectiveEntitlementId);
  for (const p of sorted) {
    db.prepare(
      `insert into learner_app_effective_sources(effective_entitlement_id,entitlement_period_id,role,valid_from,valid_until)
       values(?,?,?,?,?)`,
    ).run(effectiveEntitlementId, p.id, roleById.get(p.id), p.period_start, p.period_end);
  }
  db.prepare("update learner_app_entitlement_periods set effective_entitlement_id=? where learner_id=? and app_id=?")
    .run(effectiveEntitlementId, input.learnerId, input.appId);

  return { effectiveEntitlementId, roleById };
}

// EN-002 business rules 9-16, 44: the fresh-evaluation gate called by Start,
// LA-001 exchange and SC-003 usable launch. The materialized effective-
// entitlement row (kept in sync at write time above) supplies the stable
// id/version bookkeeping; the two genuinely time-dependent facts — whether a
// period actually covers `now`, and current app_registry status — are
// re-checked live on every call rather than trusted from the cached row, so
// a call made after a period lapses (with no intervening write) correctly
// denies access.
export function evaluateAccessFresh(input: {
  learnerId: string; appId: string; environment: string;
  useCase: "launcher" | "start" | "launch_exchange" | "usable_launch" | "resume";
  now: Date;
  // GAP-101/AT-EN-002-11: for a resume, this is the effective-entitlement
  // binding the session itself was started against (persisted on the
  // learner_sessions row at Start) — resume honors that original binding
  // through the session's own hard expiry rather than re-deriving access
  // from whatever covers `now`, which would wrongly deny resuming a session
  // that was validly active when it started but whose paid period has since
  // ended mid-session.
  boundEffectiveEntitlementId?: string | null;
}): AccessDecision {
  const db = getDb();
  const app = db.prepare("select registry_status from app_registry where id=?").get(input.appId) as
    { registry_status: string } | undefined;
  if (!app) throw new EntitlementAccessError("RESOURCE_NOT_FOUND");

  const materialized = db.prepare(
    "select id,effective_version from learner_app_effective_entitlements where learner_id=? and app_id=? and environment=?",
  ).get(input.learnerId, input.appId, input.environment) as { id: string; effective_version: number } | undefined;

  const denied = (): AccessDecision => ({
    allowed: false, state: "inactive", appId: input.appId, accessUntil: null,
    effectiveEntitlementId: materialized?.id ?? null,
    effectiveEntitlementVersion: materialized?.effective_version ?? null,
    allocationSourceState: null, coveringPeriodId: null,
  });

  if (app.registry_status !== "active") return denied();
  if (!materialized) return denied();

  expireDueCancellationForLearnerApp({ learnerId: input.learnerId, appId: input.appId, now: input.now });

  // GAP-101: resume does not re-check a live covering period at all — the
  // session's own hard-expiry/version/lifecycle checks (already enforced by
  // the caller, resumeLearnerSession) are the recovery boundary. This only
  // refuses resume if the entitlement binding itself has moved out from
  // under the session (e.g. materialization was rebuilt against a different
  // source entirely) — not merely because the calendar period lapsed.
  if (input.useCase === "resume") {
    if (input.boundEffectiveEntitlementId && input.boundEffectiveEntitlementId !== materialized.id) return denied();
    return { allowed: true, state: "active", appId: input.appId, accessUntil: null,
      effectiveEntitlementId: materialized.id, effectiveEntitlementVersion: materialized.effective_version,
      allocationSourceState: null, coveringPeriodId: null };
  }

  const nowIso = input.now.toISOString();
  const covering = db.prepare(
    `select id,period_end,effective_source_role from learner_app_entitlement_periods
     where learner_id=? and app_id=? and period_start<=? and period_end>?
     order by period_end desc limit 1`,
  ).get(input.learnerId, input.appId, nowIso, nowIso) as
    { id: string; period_end: string; effective_source_role: EffectiveSourceRole } | undefined;
  if (!covering) {
    const grace = findGraceCoverage({ learnerId: input.learnerId, appId: input.appId, now: input.now });
    if (!grace) return denied();
    return { allowed: true, state: "grace", appId: input.appId, accessUntil: grace.graceEndsAt,
      effectiveEntitlementId: materialized.id, effectiveEntitlementVersion: materialized.effective_version,
      allocationSourceState: "allocation_bearing", coveringPeriodId: grace.entitlementPeriodId };
  }

  return {
    allowed: true, state: "active", appId: input.appId, accessUntil: covering.period_end,
    effectiveEntitlementId: materialized.id, effectiveEntitlementVersion: materialized.effective_version,
    allocationSourceState: covering.effective_source_role, coveringPeriodId: covering.id,
  };
}
