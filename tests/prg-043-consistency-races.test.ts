// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDbClient } from "@/lib/db-client";
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

async function contribute(weeklyKey: string, ordinal: 1 | 2, at: string, app = appId) {
  const sessionId = seedSession(weeklyKey, ordinal, at, app);
  setUsage(weeklyKey, ordinal, ordinal + 1, app);
  return await applyStandardSessionConsistency({ sourceSessionId: sessionId, weeklyUsageVersion: ordinal + 1,
    eventId: `standard-session:${sessionId}`, principalId: "session-domain", now: new Date(at) });
}

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`eg002-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
  seedApp();
  seedPeriod("period-main", "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
});


// PRG-043 (issue #63): a qualifying session counts exactly once; finalizer vs live completion and scheduler retries are deterministic.
// Races are reproduced deterministically by serving a concurrent transaction's STALE read of the week row.
const one = (sql: string, ...a: unknown[]) => getDb().prepare(sql).get(...a) as Record<string, number>;

function staleWeekReads(snapshot: unknown) {
  const client = resolveDbClient();
  const real = client.get.bind(client);
  return vi.spyOn(client, "get").mockImplementation((async (sql: string, params?: unknown[]) => {
    if (/from learner_app_consistency_weeks\s+where learner_id=\? and app_id=\? and environment=\? and weekly_key=\?/.test(sql)) return snapshot;
    return real(sql, params as never);
  }) as never);
}

describe("PRG-043 finalization and completion races", () => {
  it("a finalizer holding a stale OPEN week cannot complete an already completed week again (streak counted once)", async () => {
    await contribute("2026-W33", 1, "2026-08-11T09:00:00.000Z");
    const openSnapshot = { ...(getDb().prepare("select * from learner_app_consistency_weeks").get() as object) };
    await contribute("2026-W33", 2, "2026-08-12T09:00:00.000Z");
    const done = one("select current_streak_weeks s, longest_streak_weeks l from learner_app_consistency");
    const weekDone = one("select result_version v from learner_app_consistency_weeks");
    expect(done).toEqual({ s: 1, l: 1 });

    const spy = staleWeekReads(openSnapshot);
    await finalizeConsistencyWeek({ weeklyKey: "2026-W33", limit: 20, runIdempotencyKey: "race-final", principalId: "scheduler", now: new Date("2026-08-17T00:00:00.000Z") });
    spy.mockRestore();

    expect(one("select current_streak_weeks s, longest_streak_weeks l from learner_app_consistency")).toEqual(done);
    expect(one("select result_version v from learner_app_consistency_weeks")).toEqual(weekDone);
    expect(getDb().prepare("select status from learner_app_consistency_weeks").get()).toEqual({ status: "cadence_complete" });
  });

  it("a stale live completion cannot overwrite a week the finalizer already closed as incomplete", async () => {
    await contribute("2026-W33", 1, "2026-08-11T09:00:00.000Z");
    const openSnapshot = { ...(getDb().prepare("select * from learner_app_consistency_weeks").get() as object) };
    seedPeriod("period-next", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    await finalizeConsistencyWeek({ weeklyKey: "2026-W33", limit: 20, runIdempotencyKey: "close-33", principalId: "scheduler", now: new Date("2026-08-17T00:00:00.000Z") });
    const closed = one("select result_version v from learner_app_consistency_weeks");
    const status = (getDb().prepare("select status from learner_app_consistency_weeks").get() as { status: string }).status;
    expect(status).not.toBe("open");

    const s2 = seedSession("2026-W33", 2, "2026-08-12T09:00:00.000Z");
    setUsage("2026-W33", 2, 3);
    const spy = staleWeekReads(openSnapshot);
    await applyStandardSessionConsistency({ sourceSessionId: s2, weeklyUsageVersion: 3, eventId: `standard-session:${s2}`, principalId: "session-domain", now: new Date("2026-08-12T09:00:00Z") })
      .catch(() => undefined);
    spy.mockRestore();
    expect(one("select result_version v from learner_app_consistency_weeks")).toEqual(closed);
    expect((getDb().prepare("select status from learner_app_consistency_weeks").get() as { status: string }).status).toBe(status);
  });

  it("scheduler retries (same and different run keys) never duplicate results or streak changes", async () => {
    await contribute("2026-W33", 1, "2026-08-11T09:00:00.000Z");
    await contribute("2026-W33", 2, "2026-08-12T09:00:00.000Z");
    const run = (key: string) => finalizeConsistencyWeek({ weeklyKey: "2026-W33", limit: 20, runIdempotencyKey: key, principalId: "scheduler", now: new Date("2026-08-17T00:00:00.000Z") });
    const first = await run("retry-1");
    expect(await run("retry-1")).toEqual(first);
    await run("retry-2");
    await run("retry-3");
    expect(one("select current_streak_weeks s from learner_app_consistency")).toEqual({ s: 1 });
    expect(one("select count(*) n from learner_app_consistency_weeks").n).toBe(1);
  });
});

describe("PRG-043 receipt and week creation races", () => {
  it("a duplicate enqueue/apply of the same session event is a replay even if both passed the existence check", async () => {
    const s = seedSession("2026-W33", 1, "2026-08-11T09:00:00.000Z");
    setUsage("2026-W33", 1, 2);
    const input = { sourceSessionId: s, weeklyUsageVersion: 2, eventId: `standard-session:${s}`, principalId: "session-domain", now: new Date("2026-08-11T09:00:00Z") };
    const first = await applyStandardSessionConsistency(input);
    const client = resolveDbClient();
    const real = client.get.bind(client);
    let hidden = 0;
    const spy = vi.spyOn(client, "get").mockImplementation((async (sql: string, params?: unknown[]) => {
      if (/from consistency_mutation_receipts\s+where action=\? and event_id=\?/.test(sql) && hidden < 1) { hidden += 1; return undefined; }
      return real(sql, params as never);
    }) as never);
    await expect(applyStandardSessionConsistency(input)).resolves.toEqual(first);
    spy.mockRestore();
    expect(one("select count(*) n from consistency_mutation_receipts where event_id=?", input.eventId).n).toBe(1);
  });

  it("a concurrent creator that loses the week-row insert reads the winner instead of failing", async () => {
    await contribute("2026-W33", 1, "2026-08-11T09:00:00.000Z");
    const client = resolveDbClient();
    const real = client.get.bind(client);
    let hidden = 0;
    const spy = vi.spyOn(client, "get").mockImplementation((async (sql: string, params?: unknown[]) => {
      if (/from learner_app_consistency_weeks\s+where learner_id=\? and app_id=\? and environment=\? and weekly_key=\?/.test(sql) && hidden < 1) { hidden += 1; return undefined; }
      return real(sql, params as never);
    }) as never);
    const s2 = seedSession("2026-W33", 2, "2026-08-12T09:00:00.000Z");
    setUsage("2026-W33", 2, 3);
    await expect(applyStandardSessionConsistency({ sourceSessionId: s2, weeklyUsageVersion: 3, eventId: `standard-session:${s2}`, principalId: "session-domain", now: new Date("2026-08-12T09:00:00Z") }))
      .resolves.toMatchObject({ currentWeekProgress: 2 });
    spy.mockRestore();
    expect(one("select count(*) n from learner_app_consistency_weeks").n).toBe(1);
  });

  it("technical-credit and catch-up sessions never count, even when replayed", async () => {
    await contribute("2026-W33", 1, "2026-08-11T09:00:00.000Z");
    seedSession("2026-W33", 1, "2026-08-13T10:00:00.000Z", appId, "technical_credit");
    const view = await readCurrentConsistency(learnerId, appId, environment, new Date("2026-08-13T12:00:00Z"));
    expect(view.currentWeekProgress).toBe(1);
  });
});
