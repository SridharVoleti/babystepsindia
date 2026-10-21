import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { recomputeEffectiveEntitlement } from "@/lib/entitlement-access/service";
import { clearLauncherAccessCache } from "@/lib/entitlement-access/launcher-cache";

// LP-005: admin-only cross-tenant per-learner-per-app view backing
// /admin/learner-apps — the weekly session cap override (learner_app_session_limits,
// supabase/migrations/0082_....) and the access end date (the learner's latest
// learner_app_entitlement_periods.period_end, re-materialised into
// learner_app_effective_entitlements.access_until).

const ENVIRONMENT = "production";

export class AdminLearnerAppError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AdminLearnerAppError";
  }
}

export type AdminLearnerAppRow = {
  learnerId: string;
  learnerName: string;
  ownerParentEmail: string;
  appId: string;
  appName: string;
  unlimitedSessions: boolean;
  weeklySessionLimitOverride: number | null;
  // True when the values above come from a learner_app_session_limits row
  // rather than being inherited from the learner-wide setting.
  sessionLimitIsAppSpecific: boolean;
  sessionLimitVersion: number;
  accessUntil: string | null;
  latestPeriodStart: string | null;
  latestPeriodEnd: string | null;
};

export async function listLearnerAppsForAdmin(search?: string): Promise<AdminLearnerAppRow[]> {
  const db = resolveDbClient();
  let query = `select e.learner_id, l.display_name as learner_name, u.email, e.app_id, a.display_name as app_name,
      l.unlimited_sessions as l_unlimited, l.weekly_session_limit_override as l_override,
      s.unlimited_sessions as s_unlimited, s.weekly_session_limit_override as s_override, s.version as s_version,
      e.access_until,
      (select p.period_start from learner_app_entitlement_periods p
        where p.learner_id = e.learner_id and p.app_id = e.app_id order by p.period_end desc limit 1) as period_start,
      (select p.period_end from learner_app_entitlement_periods p
        where p.learner_id = e.learner_id and p.app_id = e.app_id order by p.period_end desc limit 1) as period_end
     from learner_app_effective_entitlements e
     join learners l on l.id = e.learner_id
     join users u on u.id = l.owner_parent_id
     join app_registry a on a.id = e.app_id
     left join learner_app_session_limits s on s.learner_id = e.learner_id and s.app_id = e.app_id
     where e.environment = ?`;
  const params: string[] = [ENVIRONMENT];
  const term = search?.trim();
  if (term) {
    query += " and (l.display_name like ? or u.email like ? or a.display_name like ?)";
    const like = `%${term}%`;
    params.push(like, like, like);
  }
  query += " order by a.display_name, l.display_name, e.learner_id";
  const rows = await db.all<{
    learner_id: string; learner_name: string; email: string; app_id: string; app_name: string;
    l_unlimited: number | boolean; l_override: number | null;
    s_unlimited: number | boolean | null; s_override: number | null; s_version: number | null;
    access_until: string | null; period_start: string | null; period_end: string | null;
  }>(query, params);
  return rows.map((row) => {
    const appSpecific = row.s_version !== null;
    return {
      learnerId: row.learner_id, learnerName: row.learner_name, ownerParentEmail: row.email,
      appId: row.app_id, appName: row.app_name,
      unlimitedSessions: appSpecific ? !!row.s_unlimited : !!row.l_unlimited,
      weeklySessionLimitOverride: appSpecific ? row.s_override : row.l_override,
      sessionLimitIsAppSpecific: appSpecific, sessionLimitVersion: row.s_version ?? 0,
      accessUntil: row.access_until, latestPeriodStart: row.period_start, latestPeriodEnd: row.period_end,
    };
  });
}

async function assertLearnerApp(db: DbClient, learnerId: string, appId: string) {
  const row = await db.get(
    "select 1 from learner_app_effective_entitlements where learner_id=? and app_id=? and environment=?",
    [learnerId, appId, ENVIRONMENT]);
  if (!row) throw new AdminLearnerAppError("LEARNER_APP_NOT_FOUND");
}

// Resolves the effective weekly cap for one learner+app: the app-specific row
// when one exists, otherwise the learner-wide setting from 0081.
export async function resolveEffectiveSessionLimit(
  db: DbClient, learnerId: string, appId: string,
): Promise<{ unlimited: boolean; weeklyOverride: number | null }> {
  const appRow = await db.get<{ unlimited_sessions: number | boolean; weekly_session_limit_override: number | null }>(
    "select unlimited_sessions,weekly_session_limit_override from learner_app_session_limits where learner_id=? and app_id=?",
    [learnerId, appId]);
  if (appRow) return { unlimited: !!appRow.unlimited_sessions, weeklyOverride: appRow.weekly_session_limit_override };
  const learner = await db.get<{ unlimited_sessions: number | boolean; weekly_session_limit_override: number | null }>(
    "select unlimited_sessions,weekly_session_limit_override from learners where id=?", [learnerId]);
  return { unlimited: !!learner?.unlimited_sessions, weeklyOverride: learner?.weekly_session_limit_override ?? null };
}

export async function setLearnerAppSessionLimit(
  learnerId: string, appId: string,
  input: { unlimitedSessions: boolean; weeklySessionLimitOverride: number | null; expectedVersion: number },
): Promise<void> {
  if (input.weeklySessionLimitOverride !== null &&
    (!Number.isInteger(input.weeklySessionLimitOverride) || input.weeklySessionLimitOverride < 1)) {
    throw new AdminLearnerAppError("SESSION_LIMIT_OVERRIDE_INVALID");
  }
  const db = resolveDbClient();
  await assertLearnerApp(db, learnerId, appId);
  const now = new Date().toISOString();
  const unlimited = input.unlimitedSessions ? 1 : 0;
  const override = input.unlimitedSessions ? null : input.weeklySessionLimitOverride;
  if (input.expectedVersion === 0) {
    const result = await db.run(
      `insert into learner_app_session_limits(learner_id,app_id,unlimited_sessions,weekly_session_limit_override,version,updated_at)
       values(?,?,?,?,1,?) on conflict(learner_id,app_id) do nothing`,
      [learnerId, appId, unlimited, override, now]);
    if (result.changes === 0) throw new AdminLearnerAppError("LEARNER_APP_VERSION_CONFLICT");
    return;
  }
  const result = await db.run(
    `update learner_app_session_limits set unlimited_sessions=?,weekly_session_limit_override=?,
      version=version+1,updated_at=? where learner_id=? and app_id=? and version=?`,
    [unlimited, override, now, learnerId, appId, input.expectedVersion]);
  if (result.changes === 0) throw new AdminLearnerAppError("LEARNER_APP_VERSION_CONFLICT");
}

// Moves the end of the learner's latest entitlement period for this app, then
// re-materialises so access_until / active-vs-past status follow. Rewriting
// period_end (rather than access_until alone) is what makes the edit stick:
// recomputeEffectiveEntitlement derives access_until from the periods.
export async function setLearnerAppAccessEnd(
  learnerId: string, appId: string, input: { accessEnd: string; now?: Date },
): Promise<{ accessUntil: string | null }> {
  const end = new Date(input.accessEnd);
  if (Number.isNaN(end.getTime())) throw new AdminLearnerAppError("ACCESS_END_INVALID");
  const now = input.now ?? new Date();
  const result = await resolveDbClient().transaction(async (tx) => {
    await assertLearnerApp(tx, learnerId, appId);
    const period = await tx.get<{ id: string; period_start: string }>(
      `select id,period_start from learner_app_entitlement_periods where learner_id=? and app_id=?
       order by period_end desc limit 1`, [learnerId, appId]);
    if (!period) throw new AdminLearnerAppError("NO_ENTITLEMENT_PERIOD");
    if (end.getTime() <= new Date(period.period_start).getTime()) {
      throw new AdminLearnerAppError("ACCESS_END_BEFORE_PERIOD_START");
    }
    await tx.run("update learner_app_entitlement_periods set period_end=? where id=?", [end.toISOString(), period.id]);
    await recomputeEffectiveEntitlement({ learnerId, appId, environment: ENVIRONMENT, now });
    const effective = await tx.get<{ access_until: string | null }>(
      "select access_until from learner_app_effective_entitlements where learner_id=? and app_id=? and environment=?",
      [learnerId, appId, ENVIRONMENT]);
    return { accessUntil: effective?.access_until ?? null };
  });
  clearLauncherAccessCache();
  return result;
}
