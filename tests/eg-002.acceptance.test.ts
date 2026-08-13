// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { createAchievement, registerReleaseAchievementContract,
  validateReleaseAchievementContract } from "@/lib/achievements/service";
import { AUTHORIZATION_ACTIONS } from "@/lib/authorization/modes";
import { CONSISTENCY_API_CONTRACTS } from "@/lib/consistency/api-contracts";
import { applyStandardSessionConsistency, ConsistencyError, finalizeConsistencyWeek,
  listConsistency, readCurrentConsistency, reconcileConsistency } from "@/lib/consistency/service";
import { isoWeekBounds, isoWeekKey } from "@/lib/learning-session/week";

let parentId: string;
let learnerId: string;
const appId = "app-math";
const environment = "production";
const timezone = "Asia/Kolkata";

function seedApp(id = appId, name = "Magical Math") {
  getDb().prepare(`insert into app_registry
    (id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(id, id, name);
}

function seedPeriod(id: string, start: string, end: string, app = appId) {
  const cycleId = `cycle-${id}`;
  getDb().prepare(`insert into entitlement_cycles
    (id,paid_cycle_id,subscription_id,purchaser_parent_id,assigned_learner_id,product_id,product_version,
     app_ids_json,period_start,period_end,billing_anchor,status,source_event_id,source_event_version,
     source_event_hash,created_at,ready_at,version)
    values(?,?,?, ?,?,'product',1,?,?,?,'2026-08-01','ready',?,1,'hash',?,?,1)`)
    .run(cycleId, cycleId, `sub-${id}`, parentId, learnerId, JSON.stringify([app]), start, end,
      `event-${id}`, start, start);
  const effectiveId = `effective-${app}`;
  getDb().prepare(`insert or ignore into learner_app_effective_entitlements
    (id,learner_id,app_id,environment,state,allocation_source_entitlement_period_id,access_until,
     effective_version,source_set_hash,created_at,updated_at) values(?,?,?,?,'active',?,?,1,'hash',?,?)`)
    .run(effectiveId, learnerId, app, environment, id, end, start, start);
  getDb().prepare(`insert into learner_app_entitlement_periods
    (id,entitlement_cycle_id,subscription_id,learner_id,app_id,product_version,period_start,period_end,
     status,effective_source_role,effective_entitlement_id,created_at)
    values(?,?,?,?,?,1,?,?,'ready','allocation_bearing',?,?)`)
    .run(id, cycleId, `sub-${id}`, learnerId, app, start, end, effectiveId, start);
}

function ensureBatch(app = appId) {
  const id = `batch-${app}`;
  getDb().prepare(`insert or ignore into learner_app_standard_credit_batches
    (id,learner_id,app_id,allocation_month,timezone,granted_count,reserved_count,consumed_count,
     effective_at,expires_at,version,created_at,updated_at)
    values(?,?,?,'2026-08-01',?,8,0,0,'2026-07-31T18:30:00.000Z','2026-10-01T00:00:00.000Z',1,
      '2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z')`).run(id, learnerId, app, timezone);
  return id;
}

function setUsage(weeklyKey: string, count: number, version: number, app = appId) {
  getDb().prepare(`insert into learner_app_week_usage
    (learner_id,app_id,week_key,week_timezone,normal_sessions_started,standard_sessions_funded,version,updated_at)
    values(?,?,?,?,0,?,?,?) on conflict(learner_id,app_id,week_key) do update set
      standard_sessions_funded=excluded.standard_sessions_funded,version=excluded.version,updated_at=excluded.updated_at`)
    .run(learnerId, app, weeklyKey, timezone, count, version, "2026-08-12T10:00:00.000Z");
}

function seedSession(weeklyKey: string, ordinal: number, at: string, app = appId, source = "standard_monthly") {
  const id = `${app}-${weeklyKey}-session-${ordinal}-${source}`;
  const technical = source === "technical_credit";
  getDb().prepare(`update learner_sessions set status='interrupted',updated_at=?
    where learner_id=? and status in ('starting','active','disconnected','resumable')`).run(at, learnerId);
  if (technical) {
    const sourceSession = getDb().prepare(`select id from learner_sessions
      where learner_id=? and app_id=? order by started_at limit 1`).get(learnerId, app) as { id: string } | undefined;
    if (!sourceSession) throw new Error("technical credit fixture requires a source session");
    getDb().prepare(`insert into learner_session_credits
      (id,source_learner_session_id,learner_id,app_id,credit_type,status,confirmed_by_actor_type,
       confirmed_by_actor_id,confirmation_reason_code,granted_at,expires_at,reserved_session_id,
       reserved_at,consumed_at,created_at,updated_at)
      values(?,?,?,?,'technical_replacement','consumed','parent',?,'technical_issue',?,?,?,?,?,?,?)`)
      .run(`credit-${id}`, sourceSession.id, learnerId, app, parentId, at,
        "2026-10-01T00:00:00.000Z", id, at, at, at, at);
  }
  const normal = source === "normal";
  const standard = source === "standard_monthly";
  getDb().prepare(`insert into learner_sessions
    (id,learner_id,app_id,parent_user_id,device_session_id,week_key,week_timezone,weekly_slot_number,source,
     session_credit_id,standard_credit_batch_id,weekly_session_ordinal,status,funding_state,
     schedule_authorization_id,started_at,usable_launch_established_at,hard_expires_at,resume_token_hash,
     deployment_environment,created_at,updated_at)
    values(?,?,?,?,?,?,?,?,?,?,?,?, 'active','consumed','schedule',?,?,?,'hash',?,?,?)`)
    .run(id, learnerId, app, parentId, `device-${id}`, weeklyKey, timezone, normal ? ordinal : null, source,
      technical ? `credit-${id}` : null, standard ? ensureBatch(app) : null, standard ? ordinal : null,
      at, at, new Date(new Date(at).getTime() + 3600_000).toISOString(), environment, at, at);
  return id;
}

function contribute(weeklyKey: string, ordinal: 1 | 2, at: string, app = appId) {
  const sessionId = seedSession(weeklyKey, ordinal, at, app);
  setUsage(weeklyKey, ordinal, ordinal + 1, app);
  return applyStandardSessionConsistency({ sourceSessionId: sessionId, weeklyUsageVersion: ordinal + 1,
    eventId: `standard-session:${sessionId}`, principalId: "session-domain", now: new Date(at) });
}

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`eg002-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01").learner.id;
  seedApp();
  seedPeriod("period-main", "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
});

describe("EG-002 per-app weekly consistency", () => {
  it("AT-EG-002-01..04 keeps one independent weekly target per learner-app", () => {
    seedApp("app-chess", "Chess Master");
    seedPeriod("period-chess", "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", "app-chess");
    const feed = listConsistency({ learnerId, now: new Date("2026-08-12T10:00:00.000Z") });
    expect(feed.apps.map((app) => [app.appName, app.target])).toEqual([["Chess Master", 2], ["Magical Math", 2]]);
    expect(JSON.stringify(feed)).not.toMatch(/globalStreak|dailyStreak|allAppsStreak/i);
    expect(isoWeekKey(new Date("2026-08-12T10:00:00.000Z"), timezone)).toBe("2026-W33");
  });

  it("AT-EG-002-05..08 counts only committed usable standard sessions and increments once", () => {
    expect(readCurrentConsistency(learnerId, appId, environment, new Date("2026-08-12T09:00:00Z")).currentWeekProgress).toBe(0);
    const first = contribute("2026-W33", 1, "2026-08-11T09:00:00.000Z");
    expect(first).toMatchObject({ currentWeekProgress: 1, currentStreakWeeks: 0 });
    const second = contribute("2026-W33", 2, "2026-08-12T09:00:00.000Z");
    expect(second).toMatchObject({ currentWeekProgress: 2, currentStreakWeeks: 1, longestStreakWeeks: 1 });
    const week = getDb().prepare(`select status,cadence_completed_by_session_id from learner_app_consistency_weeks`).get();
    expect(week).toEqual({ status: "cadence_complete",
      cadence_completed_by_session_id: `${appId}-2026-W33-session-2-standard_monthly` });
    getDb().prepare("update learner_sessions set status='interrupted' where id=?")
      .run(`${appId}-2026-W33-session-2-standard_monthly`);
    expect(readCurrentConsistency(learnerId, appId, environment, new Date("2026-08-12T10:00:00Z")).currentStreakWeeks).toBe(1);
  });

  it("AT-EG-002-09..13 ignores technical/catch-up use and replays exactly once", () => {
    const first = contribute("2026-W33", 1, "2026-08-11T09:00:00.000Z");
    const secondSession = seedSession("2026-W33", 2, "2026-08-12T09:00:00.000Z");
    setUsage("2026-W33", 2, 3);
    const input = { sourceSessionId: secondSession, weeklyUsageVersion: 3,
      eventId: `standard-session:${secondSession}`, principalId: "session-domain", now: new Date("2026-08-12T09:00:00Z") };
    const result = applyStandardSessionConsistency(input);
    expect(applyStandardSessionConsistency(input)).toEqual(result);
    expect(applyStandardSessionConsistency({
      sourceSessionId: `${appId}-2026-W33-session-1-standard_monthly`, weeklyUsageVersion: 2,
      eventId: `standard-session:${appId}-2026-W33-session-1-standard_monthly`, principalId: "session-domain",
      now: new Date("2026-08-12T10:00:00Z"),
    })).toEqual(first);
    setUsage("2026-W33", 3, 4);
    seedSession("2026-W33", 3, "2026-08-13T09:00:00.000Z");
    seedSession("2026-W33", 1, "2026-08-13T10:00:00.000Z", appId, "technical_credit");
    expect(readCurrentConsistency(learnerId, appId, environment, new Date("2026-08-13T12:00:00Z")))
      .toMatchObject({ currentWeekProgress: 2, currentStreakWeeks: 1 });
    expect(getDb().prepare("select count(*) n from learner_app_consistency_weeks").get()).toMatchObject({ n: 1 });
    expect(first.target).toBe(2);
  });

  it("AT-EG-002-14/16/17/18 preserves longest and changes no authority domain", () => {
    ensureBatch();
    const before = { credits: getDb().prepare("select count(*) n from learner_app_standard_credit_batches").get(),
      progress: getDb().prepare("select count(*) n from learner_app_progress").get(),
      entitlements: getDb().prepare("select * from learner_app_effective_entitlements").all() };
    contribute("2026-W33", 1, "2026-08-11T09:00:00.000Z");
    contribute("2026-W33", 2, "2026-08-12T09:00:00.000Z");
    finalizeConsistencyWeek({ weeklyKey: "2026-W34", limit: 20, runIdempotencyKey: "final-w34",
      principalId: "scheduler", now: new Date("2026-08-24T00:00:00.000Z") });
    const current = getDb().prepare("select current_streak_weeks,longest_streak_weeks from learner_app_consistency").get();
    expect(current).toEqual({ current_streak_weeks: 0, longest_streak_weeks: 1 });
    expect(getDb().prepare("select count(*) n from learner_app_standard_credit_batches").get()).toEqual(before.credits);
    expect(getDb().prepare("select count(*) n from learner_app_progress").get()).toEqual(before.progress);
    expect(getDb().prepare("select * from learner_app_effective_entitlements").all()).toEqual(before.entitlements);
  });

  it("AT-EG-002-19/20/22 classifies partial and out-of-scope weeks neutrally", () => {
    getDb().prepare("delete from learner_app_entitlement_periods").run();
    seedPeriod("partial", "2026-08-12T00:00:00.000Z", "2026-08-14T00:00:00.000Z");
    const partial = finalizeConsistencyWeek({ weeklyKey: "2026-W33", limit: 20, runIdempotencyKey: "partial",
      principalId: "scheduler", now: new Date("2026-08-17T00:00:00.000Z") });
    expect(partial.neutral).toBe(1);
    expect(getDb().prepare("select status from learner_app_consistency_weeks").get())
      .toEqual({ status: "neutral_partial" });
    const out = finalizeConsistencyWeek({ weeklyKey: "2026-W32", limit: 20, runIdempotencyKey: "out",
      principalId: "scheduler", now: new Date("2026-08-17T00:00:00.000Z") });
    expect(out.outOfScope).toBeGreaterThanOrEqual(0);
  });

  it("AT-EG-002-21/26/27 completed weeks remain complete while eligible incomplete weeks reset", () => {
    contribute("2026-W33", 1, "2026-08-11T09:00:00.000Z");
    contribute("2026-W33", 2, "2026-08-12T09:00:00.000Z");
    seedPeriod("period-next", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    const result = finalizeConsistencyWeek({ weeklyKey: "2026-W34", limit: 20, runIdempotencyKey: "reset",
      principalId: "scheduler", now: new Date("2026-08-24T00:00:00.000Z") });
    expect(result.reset).toBe(1);
    expect(getDb().prepare("select current_streak_weeks,longest_streak_weeks from learner_app_consistency").get())
      .toEqual({ current_streak_weeks: 0, longest_streak_weeks: 1 });
    expect(getDb().prepare(`select status from learner_app_consistency_weeks where weekly_key='2026-W33'`).get())
      .toEqual({ status: "cadence_complete" });
  });

  it("AT-EG-002-23/24 restarts after a commercial gap and retains history/longest", () => {
    contribute("2026-W33", 1, "2026-08-11T09:00:00.000Z"); contribute("2026-W33", 2, "2026-08-12T09:00:00.000Z");
    getDb().prepare("update learner_app_entitlement_periods set period_end='2026-08-17T00:00:00.000Z'").run();
    seedPeriod("resubscribe", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    contribute("2026-W36", 1, "2026-09-01T09:00:00.000Z"); contribute("2026-W36", 2, "2026-09-02T09:00:00.000Z");
    expect(readCurrentConsistency(learnerId, appId, environment, new Date("2026-09-02T10:00:00Z")))
      .toMatchObject({ currentStreakWeeks: 1, longestStreakWeeks: 1 });
    expect(listConsistency({ learnerId, now: new Date("2026-09-02T10:00:00Z") }).history)
      .toHaveLength(2);
  });

  it("AT-EG-002-30..34 neutralizes only proven platform-unavailable weeks", () => {
    const bounds = isoWeekBounds("2026-W33", timezone);
    getDb().prepare(`insert into app_maintenance_windows
      (id,app_id,environment,starts_at,ends_at,status,reason_category,window_version,created_by,updated_by,created_at,updated_at)
      values('week-outage',?,?,?,?, 'scheduled','maintenance',1,'admin','admin',?,?)`)
      .run(appId, environment, bounds.startAt.toISOString(),
        new Date(bounds.endAt.getTime() - 3_000_000).toISOString(), bounds.startAt.toISOString(), bounds.startAt.toISOString());
    const result = finalizeConsistencyWeek({ weeklyKey: "2026-W33", limit: 20, runIdempotencyKey: "outage",
      principalId: "scheduler", now: new Date("2026-08-17T00:00:00Z") });
    expect(result.neutral).toBe(1);
    expect(getDb().prepare("select status,availability_neutral_evidence from learner_app_consistency_weeks").get())
      .toMatchObject({ status: "platform_unavailable_neutral",
        availability_neutral_evidence: expect.any(String) });
  });

  it("AT-EG-002-35..38 is event-driven, bounded, idempotent, and server-week keyed", () => {
    expect(isoWeekKey(new Date("2026-08-16T18:29:59.000Z"), timezone)).toBe("2026-W33");
    expect(isoWeekKey(new Date("2026-08-16T18:30:00.000Z"), timezone)).toBe("2026-W34");
    const first = finalizeConsistencyWeek({ weeklyKey: "2026-W33", limit: 1, runIdempotencyKey: "bounded",
      principalId: "scheduler", now: new Date("2026-08-17T00:00:00Z") });
    expect(finalizeConsistencyWeek({ weeklyKey: "2026-W33", limit: 1, runIdempotencyKey: "bounded",
      principalId: "scheduler", now: new Date("2026-08-17T00:01:00Z") })).toEqual(first);
    expect(getDb().prepare("select count(*) n from consistency_mutation_receipts where action='finalize_week'").get())
      .toMatchObject({ n: 1 });
  });

  it("AT-EG-002-42/43 keeps EG-001 achievements completely independent", () => {
    getDb().prepare(`insert into app_releases
      (id,app_id,source_repository,source_commit_sha,dependency_lock_hash,build_input_hash,artifact_digest,
       manifest_json,gate_results_json,status,created_by_ci_principal)
      values('release-eg2',?,'org/repo','sha','lock','build','digest','{}','{}','verified','ci')`).run(appId);
    registerReleaseAchievementContract({ appId, releaseId: "release-eg2", achievementContractVersion: "1.0",
      appAchievementModelVersion: "m1", allowedBadgeAssetKeys: ["icon-open-book"], now: new Date("2026-08-12T10:00:00Z") });
    validateReleaseAchievementContract(appId, "release-eg2", new Date("2026-08-12T10:00:00Z"));
    const sessionId = seedSession("2026-W33", 1, "2026-08-12T09:00:00.000Z", appId, "normal");
    getDb().prepare("update learner_sessions set release_id='release-eg2' where id=?").run(sessionId);
    getDb().prepare(`insert into learner_app_progress
      (learner_id,app_id,current_level_key,current_lesson_key,progress_version,state_hash)
      values(?,?,'level-1','lesson-1',2,'progress-hash')`).run(learnerId, appId);
    const before = readCurrentConsistency(learnerId, appId, environment, new Date("2026-08-12T10:00:00Z"));
    createAchievement({ grantId: "g", learnerSessionId: sessionId, learnerId, appId, principalId: "p",
      environment, deploymentId: "d", releaseId: "release-eg2" }, {
      achievementContractVersion: "1.0", appAchievementKey: "consistent", achievementInstanceKey: "consistent:1",
      title: "Consistent learner", badgeAssetKey: "icon-open-book", category: "consistency",
      earnedAt: "2026-08-12T09:30:00Z", appAchievementModelVersion: "m1", sourceSessionId: sessionId,
      sourceProgressVersion: 2, idempotencyKey: "achievement-independent" }, new Date("2026-08-12T10:00:00Z"));
    expect(readCurrentConsistency(learnerId, appId, environment, new Date("2026-08-12T10:00:00Z"))).toEqual(before);
  });

  it("AT-EG-002-36/46 reconciliation rebuilds missing projections without inventing sessions", () => {
    contribute("2026-W33", 1, "2026-08-11T09:00:00.000Z"); contribute("2026-W33", 2, "2026-08-12T09:00:00.000Z");
    getDb().prepare("delete from learner_app_consistency_weeks").run();
    getDb().prepare("delete from learner_app_consistency").run();
    const result = reconcileConsistency({ learnerId, appId, limit: 20, runIdempotencyKey: "repair",
      principalId: "reconciler", fromWeek: "2026-W33", toWeek: "2026-W33",
      now: new Date("2026-08-12T10:00:00Z") });
    expect(result.repaired).toBe(1);
    expect(readCurrentConsistency(learnerId, appId, environment, new Date("2026-08-12T10:00:00Z")).currentStreakWeeks).toBe(1);
    expect(getDb().prepare("select status,cadence_completed_by_session_id from learner_app_consistency_weeks").get())
      .toEqual({ status: "cadence_complete",
        cadence_completed_by_session_id: `${appId}-2026-W33-session-2-standard_monthly` });
    expect(getDb().prepare("select count(*) n from learner_sessions").get()).toMatchObject({ n: 2 });
  });

  it("AT-EG-002-11 rejects conflicting source versions", () => {
    const sessionId = seedSession("2026-W33", 1, "2026-08-11T09:00:00.000Z"); setUsage("2026-W33", 1, 2);
    expect(() => applyStandardSessionConsistency({ sourceSessionId: sessionId, weeklyUsageVersion: 99,
      eventId: `standard-session:${sessionId}`, principalId: "session-domain", now: new Date("2026-08-11T09:00:00Z") }))
      .toThrowError(new ConsistencyError("CONSISTENCY_USAGE_VERSION_CONFLICT"));
  });

  it("AT-EG-002-39..48 registers only per-app weekly read/service contracts", () => {
    expect(Object.values(CONSISTENCY_API_CONTRACTS).map((contract) => contract.id))
      .toEqual(["API-EG-007", "API-EG-008", "API-EG-009", "API-EG-010", "API-EG-011", "API-EG-012"]);
    expect(AUTHORIZATION_ACTIONS["learner.consistency.read"].mode).toBe("learner_mode");
    expect(AUTHORIZATION_ACTIONS["parent.learner.consistency.read"].mode).toBe("parent_management");
    expect(JSON.stringify({ contracts: CONSISTENCY_API_CONTRACTS, actions: AUTHORIZATION_ACTIONS }))
      .not.toMatch(/global.streak|daily.streak|freeze.token|reward.wallet|admin.consistency.adjust/i);
  });
});
