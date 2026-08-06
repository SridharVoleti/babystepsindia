// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { createLearner } from "@/lib/db/learner-repo";
import {
  LearnerSessionError,
  cancelStartReservation,
  completeLearnerSession,
  confirmUsableLaunch,
  disconnectLearnerSession,
  establishUsableLaunch,
  getLearnerSelection,
  resumeLearnerSession,
  selectLearner,
  startLearnerSession,
  sweepExpiredLearnerSessions,
  sweepExpiredStartReservations,
} from "@/lib/learning-session/gateway";
import { isoWeekKey } from "@/lib/learning-session/week";
import { consumeTechnicalCredit, restoreTechnicalCredit } from "@/lib/session-credit/service";
import { recomputeEffectiveEntitlement } from "@/lib/entitlement-access/service";

beforeEach(() => {
  useInMemoryDb();
  process.env.LEARNING_SESSION_SECRET = "test-only-learning-session-secret-32-bytes";
  process.env.ANALYTICS_HMAC_SECRET = "analytics-test-secret-at-least-32-characters";
  process.env.SESSION_ENVELOPE_SECRET = "session-envelope-test-secret-at-least-32-chars";
  registerMathApp();
});

function registerMathApp(){getDb().prepare(`insert or ignore into app_registry(id,app_key,display_name,registry_status)
  values('math-app','math-app','Math App','active'),('chess-app','chess-app','Chess App','active'),
  ('unentitled-app','unentitled-app','Unentitled App','active')`).run();}

// EN-002: startLearnerSession now fresh-evaluates access via
// evaluateAccessFresh instead of trusting a caller-supplied boolean. These
// gateway tests aren't exercising EN-001/EN-002 themselves (that's
// entitlement-cycle-service.test.ts / entitlement-access-service.test.ts) —
// they need a wide-open, always-valid entitlement per fixture learner so the
// existing session-lifecycle assertions keep testing what they were testing.
function seedEntitlement(parentId: string, learnerId: string, appId: string, environment = "production") {
  const db = getDb();
  const cycleId = `cycle-${learnerId}-${appId}`;
  const periodId = `period-${learnerId}-${appId}`;
  const subscriptionId = `sub-${cycleId}`;
  const fixtureTimestamp = "2020-01-01T00:00:00.000Z";
  db.prepare(`insert into entitlement_cycles(id,paid_cycle_id,subscription_id,purchaser_parent_id,
    assigned_learner_id,product_id,product_version,app_ids_json,period_start,period_end,billing_anchor,
    status,source_event_id,source_event_version,source_event_hash,created_at,ready_at,version)
    values(?,?,?,?,?,'product-fixture',1,'[]','2020-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z',
    '2020-01-01','ready',?,1,'fixture-hash',?,?,1)`)
    .run(cycleId, cycleId, subscriptionId, parentId, learnerId, `event-${cycleId}`, fixtureTimestamp, fixtureTimestamp);
  db.prepare(`insert into learner_app_entitlement_periods(id,entitlement_cycle_id,subscription_id,learner_id,
    app_id,product_version,period_start,period_end,status,effective_source_role,created_at)
    values(?,?,?,?,?,1,'2020-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z','ready','allocation_bearing',?)`)
    .run(periodId, cycleId, subscriptionId, learnerId, appId, fixtureTimestamp);
  recomputeEffectiveEntitlement({ learnerId, appId, environment, now: new Date("2026-08-04T10:00:00.000Z") });
}

async function fixture(learnerCount = 1) {
  registerMathApp();
  const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
  getDb().prepare("update profiles set onboarding_status='learner_pending' where id=?").run(user.id);
  const learners = Array.from({ length: learnerCount }, (_, index) => createLearner(user.id, {
    displayName: `Learner ${index + 1}`,
    dateOfBirth: "2018-01-01",
    idempotencyKey: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  }, "2026-08-04").learner);
  for (const learner of learners) {
    seedEntitlement(user.id, learner.id, "math-app");
    seedEntitlement(user.id, learner.id, "chess-app");
  }
  return { user, learners };
}

function ctx(sessionId: string, learnerId: string, appId = "math-app") {
  return { grantId: "test-grant", principalId: "test-principal", learnerSessionId: sessionId, learnerId, appId };
}

// SC-003: most disconnect/resume/complete tests below care about
// post-activation behavior, not the reserve->confirm dance itself (covered
// by its own "SC-003 start reservation" describe block) — this is a direct
// shortcut to active, distinct from the real confirmUsableLaunch flow.
function markActive(sessionId: string) {
  getDb().prepare("update learner_sessions set status='active' where id=?").run(sessionId);
}

function startInput(parentId: string, learnerId: string, overrides = {}) {
  return {
    actorSessionId: "30000000-0000-4000-8000-000000000001",
    parentUserId: parentId,
    selectedLearnerId: learnerId,
    learnerId,
    appId: "math-app",
    deviceSessionId: "40000000-0000-4000-8000-000000000001",
    scheduleAuthorizationId: "schedule-1",
    scheduleAuthorized: true,
    idempotencyKey: "50000000-0000-4000-8000-000000000001",
    now: new Date("2026-08-04T10:00:00.000Z"),
    deployment: {
      deploymentId: "60000000-0000-4000-8000-000000000001",
      releaseId: "70000000-0000-4000-8000-000000000001",
      environment: "production",
      origin: "https://math.example",
      launchPath: "/launch",
      compatibilityPassed: true,
      dispatchBlocked: false,
    },
    ...overrides,
  };
}

describe("LP-004 selection", () => {
  it("auto-selects exactly one learner but requires explicit selection for multiple", async () => {
    const one = await fixture(1);
    expect(getLearnerSelection("session-one", one.user.id, "2026-08-05T00:00:00Z"))
      .toMatchObject({ selectedLearnerId: one.learners[0].id, requiresSelection: false });

    useInMemoryDb();
    const many = await fixture(2);
    expect(getLearnerSelection("session-many", many.user.id, "2026-08-05T00:00:00Z"))
      .toMatchObject({ selectedLearnerId: null, requiresSelection: true });
    expect(selectLearner("session-many", many.user.id, many.learners[1].id, "2026-08-05T00:00:00Z"))
      .toMatchObject({ selectedLearnerId: many.learners[1].id });
  });

  it("does not carry selection into a different parent authentication session", async () => {
    const { user, learners } = await fixture(2);
    selectLearner("old-session", user.id, learners[0].id, "2026-08-05T00:00:00Z");
    expect(getLearnerSelection("new-session", user.id, "2026-08-05T00:00:00Z").selectedLearnerId)
      .toBeNull();
  });
});

describe("LP-004 session gateway", () => {
  it("derives ISO week in learner timezone", () => {
    expect(isoWeekKey(new Date("2026-01-04T20:00:00Z"), "Asia/Kolkata")).toBe("2026-W02");
  });

  it("starts once, consumes one weekly slot, and replays idempotently", async () => {
    const { user, learners } = await fixture();
    const input = startInput(user.id, learners[0].id);
    const first = startLearnerSession(input);
    const replay = startLearnerSession(input);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ weeklySlotNumber: 1, source: "normal", status: "starting" });
    expect((getDb().prepare("select normal_sessions_started n from learner_app_week_usage").get() as { n: number }).n)
      .toBe(1);
  });

  it("blocks every second app/device start while the learner is reserved", async () => {
    const { user, learners } = await fixture();
    startLearnerSession(startInput(user.id, learners[0].id));
    expect(() => startLearnerSession(startInput(user.id, learners[0].id, {
      appId: "chess-app",
      deviceSessionId: "40000000-0000-4000-8000-000000000002",
      idempotencyKey: "50000000-0000-4000-8000-000000000002",
    }))).toThrowError(new LearnerSessionError("LEARNER_SESSION_IN_PROGRESS"));
  });

  it("rejects missing entitlement, wrong selection, and unscheduled app before usage", async () => {
    const { user, learners } = await fixture();
    for (const [override, code] of [
      [{ appId: "unentitled-app" }, "ENTITLEMENT_INACTIVE"],
      [{ selectedLearnerId: "other" }, "LEARNER_SELECTION_MISMATCH"],
      [{ scheduleAuthorized: false }, "APP_SESSION_NOT_SCHEDULED"],
    ] as const) {
      expect(() => startLearnerSession(startInput(user.id, learners[0].id, override)))
        .toThrowError(new LearnerSessionError(code));
    }
    expect((getDb().prepare("select count(*) n from learner_app_week_usage").get() as { n: number }).n).toBe(0);
  });

  it("SC-001 establishes usable launch once, computes hard expiry, and caps reported time by wall clock", async () => {
    const { user, learners } = await fixture();
    const started = startLearnerSession(startInput(user.id, learners[0].id));
    markActive(started.sessionId);
    const established = establishUsableLaunch(started.sessionId, new Date("2026-08-04T10:00:05.000Z"));
    expect(established).toMatchObject({ usableLaunchEstablishedAt: "2026-08-04T10:00:05.000Z",
      hardExpiresAt: "2026-08-04T11:00:05.000Z", maximumConnectedSeconds: 2700, alreadyEstablished: false });
    // idempotent: a second call (e.g. an exchange retry) must not move the clock
    expect(establishUsableLaunch(started.sessionId, new Date("2026-08-04T10:05:00.000Z")))
      .toMatchObject({ ...established, alreadyEstablished: true });
    // only 30 seconds of wall clock have actually elapsed since usable launch,
    // so a wildly over-reported value is capped by the wall clock, not just the 2700s maximum
    const disconnected = disconnectLearnerSession(ctx(started.sessionId, learners[0].id), {
      reportedConnectedSeconds: 9999, now: new Date("2026-08-04T10:00:35.000Z"),
    });
    expect(disconnected.status).toBe("disconnected");
    expect(getDb().prepare("select connected_elapsed_seconds n from learner_sessions where id=?").get(started.sessionId))
      .toMatchObject({ n: 30 });
  });

  it("disconnects and resumes the same session/slot only on the original device", async () => {
    const { user, learners } = await fixture();
    const started = startLearnerSession(startInput(user.id, learners[0].id));
    markActive(started.sessionId);
    disconnectLearnerSession(ctx(started.sessionId, learners[0].id), {
      now: new Date("2026-08-04T10:05:00.000Z"),
    });
    expect(() => resumeLearnerSession(ctx(started.sessionId, learners[0].id), {
      deviceSessionId: "different-device", credential: started.resumeCredential,
      now: new Date("2026-08-04T10:10:00.000Z"),
    })).toThrowError(new LearnerSessionError("SESSION_RESUME_DEVICE_MISMATCH"));
    const resumed = resumeLearnerSession(ctx(started.sessionId, learners[0].id), {
      deviceSessionId: "40000000-0000-4000-8000-000000000001", credential: started.resumeCredential,
      now: new Date("2026-08-04T10:10:00.000Z"),
    });
    expect(resumed).toMatchObject({ sessionId: started.sessionId, weeklySlotNumber: 1, status: "active" });
    expect((getDb().prepare("select count(*) n from learner_sessions").get() as { n: number }).n).toBe(1);
  });

  it("SC-001 denies resume past hard expiry and releases the lock", async () => {
    const { user, learners } = await fixture();
    const started = startLearnerSession(startInput(user.id, learners[0].id));
    markActive(started.sessionId);
    establishUsableLaunch(started.sessionId, new Date("2026-08-04T10:00:00.000Z"));
    disconnectLearnerSession(ctx(started.sessionId, learners[0].id), { now: new Date("2026-08-04T10:05:00.000Z") });
    expect(() => resumeLearnerSession(ctx(started.sessionId, learners[0].id), {
      deviceSessionId: "40000000-0000-4000-8000-000000000001", credential: started.resumeCredential,
      now: new Date("2026-08-04T11:00:06.000Z"),
    })).toThrowError(new LearnerSessionError("SESSION_HARD_EXPIRED"));
    expect(getDb().prepare("select status,end_reason from learner_sessions where id=?").get(started.sessionId))
      .toMatchObject({ status: "interrupted", end_reason: "session_hard_expired" });
  });

  it("allows exactly two normal sessions per learner/app/week", async () => {
    const { user, learners } = await fixture();
    const first = startLearnerSession(startInput(user.id, learners[0].id));
    markActive(first.sessionId);
    completeLearnerSession(first.sessionId, first.sessionToken, {
      deviceSessionId: "40000000-0000-4000-8000-000000000001",
      now: new Date("2026-08-04T10:01:00.000Z"),
    });
    const second = startLearnerSession(startInput(user.id, learners[0].id, {
      idempotencyKey: "50000000-0000-4000-8000-000000000002",
      now: new Date("2026-08-04T10:02:00.000Z"),
    }));
    markActive(second.sessionId);
    expect(second.weeklySlotNumber).toBe(2);
    completeLearnerSession(second.sessionId, second.sessionToken, {
      deviceSessionId: "40000000-0000-4000-8000-000000000001",
      now: new Date("2026-08-04T10:03:00.000Z"),
    });
    expect(() => startLearnerSession(startInput(user.id, learners[0].id, {
      idempotencyKey: "50000000-0000-4000-8000-000000000003",
      now: new Date("2026-08-04T10:04:00.000Z"),
    }))).toThrowError(new LearnerSessionError("WEEKLY_SESSION_LIMIT_REACHED"));
  });

  it("sweeps expired recovery state and releases the learner lock", async () => {
    const { user, learners } = await fixture();
    const started = startLearnerSession(startInput(user.id, learners[0].id));
    markActive(started.sessionId);
    disconnectLearnerSession(ctx(started.sessionId, learners[0].id), {
      now: new Date("2026-08-04T10:01:00.000Z"),
    });
    expect(sweepExpiredLearnerSessions(new Date("2026-08-04T10:16:01.000Z"))).toBe(1);
    expect((getDb().prepare("select status from learner_sessions where id=?").get(started.sessionId) as { status: string }).status)
      .toBe("interrupted");
    // The disconnect transition already counted this episode; expiring its
    // recovery window must not count the same interruption twice.
    expect(getDb().prepare("select sum(sessions_interrupted) n from analytics_daily_buffer").get())
      .toMatchObject({ n: 1 });
    expect(() => resumeLearnerSession(ctx(started.sessionId, learners[0].id), {
      deviceSessionId: "40000000-0000-4000-8000-000000000001", credential: started.resumeCredential,
      now: new Date("2026-08-04T10:16:02.000Z"),
    })).toThrowError(new LearnerSessionError("SESSION_NOT_RESUMABLE"));
  });

  it("SC-001 sweeps a hard-expired active session that never disconnected", async () => {
    const { user, learners } = await fixture();
    const started = startLearnerSession(startInput(user.id, learners[0].id));
    markActive(started.sessionId);
    establishUsableLaunch(started.sessionId, new Date("2026-08-04T10:00:00.000Z"));
    expect(sweepExpiredLearnerSessions(new Date("2026-08-04T11:00:01.000Z"))).toBe(1);
    expect(getDb().prepare("select status,end_reason from learner_sessions where id=?").get(started.sessionId))
      .toMatchObject({ status: "interrupted", end_reason: "session_hard_expired" });
    // This active session vanished without a disconnect request, so the
    // sweeper owns its one interruption contribution.
    expect(getDb().prepare("select sum(sessions_interrupted) n from analytics_daily_buffer").get())
      .toMatchObject({ n: 1 });
    expect(sweepExpiredLearnerSessions(new Date("2026-08-04T11:01:00.000Z"))).toBe(0);
    expect(getDb().prepare("select sum(sessions_interrupted) n from analytics_daily_buffer").get())
      .toMatchObject({ n: 1 });
  });

  it("LA-004 counts distinct interruption episodes once and completes only after the strict threshold", async () => {
    registerMathApp();const {user,learners}=await fixture();const started=startLearnerSession(startInput(user.id,learners[0].id));
    markActive(started.sessionId);
    getDb().prepare("update learner_sessions set connected_elapsed_seconds=2025,interruption_episode_count=2 where id=?")
      .run(started.sessionId);
    const atBoundary=disconnectLearnerSession(ctx(started.sessionId,learners[0].id),{
      now:new Date("2026-08-04T10:01:00.000Z")});
    expect(atBoundary.status).toBe("disconnected");
    disconnectLearnerSession(ctx(started.sessionId,learners[0].id),{
      now:new Date("2026-08-04T10:01:01.000Z")});
    expect(getDb().prepare("select interruption_episode_count n from learner_sessions where id=?").get(started.sessionId)).toMatchObject({n:3});
    resumeLearnerSession(ctx(started.sessionId,learners[0].id),{deviceSessionId:startInput(user.id,learners[0].id).deviceSessionId,
      credential:started.resumeCredential,now:new Date("2026-08-04T10:01:02.000Z")});
    getDb().prepare("update learner_sessions set connected_elapsed_seconds=2026 where id=?").run(started.sessionId);
    const completed=disconnectLearnerSession(ctx(started.sessionId,learners[0].id),{
      now:new Date("2026-08-04T10:01:03.000Z")});
    expect(completed.status).toBe("completed");
    expect(getDb().prepare("select end_reason from learner_sessions where id=?").get(started.sessionId))
      .toMatchObject({end_reason:"repeated_interruption_after_threshold"});
  });

  it("SC-001 disconnect reporting the maximum connected seconds finalizes as time_limit_reached", async () => {
    registerMathApp();const {user,learners}=await fixture();const started=startLearnerSession(startInput(user.id,learners[0].id));
    markActive(started.sessionId);
    establishUsableLaunch(started.sessionId, new Date("2026-08-04T09:00:00.000Z"));
    getDb().prepare("update learner_sessions set connected_elapsed_seconds=2690 where id=?").run(started.sessionId);
    const result=disconnectLearnerSession(ctx(started.sessionId,learners[0].id),{
      reportedConnectedSeconds:2700,now:new Date("2026-08-04T10:00:10.000Z")});
    expect(result.status).toBe("completed");
    expect(getDb().prepare("select end_reason,connected_elapsed_seconds,resume_token_hash from learner_sessions where id=?").get(started.sessionId))
      .toMatchObject({end_reason:"time_limit_reached",connected_elapsed_seconds:2700,resume_token_hash:""});
  });

  it("LA-004 technical credit bypasses weekly/schedule gates, reserves for start and consumes once usable", async () => {
    registerMathApp();const {user,learners}=await fixture();
    const first=startLearnerSession(startInput(user.id,learners[0].id));markActive(first.sessionId);
    completeLearnerSession(first.sessionId,first.sessionToken,
      {deviceSessionId:startInput(user.id,learners[0].id).deviceSessionId,now:new Date("2026-08-04T10:01:00.000Z")});
    const second=startLearnerSession(startInput(user.id,learners[0].id,{idempotencyKey:"normal-2",now:new Date("2026-08-04T10:02:00.000Z")}));
    markActive(second.sessionId);
    completeLearnerSession(second.sessionId,second.sessionToken,{deviceSessionId:startInput(user.id,learners[0].id).deviceSessionId,
      now:new Date("2026-08-04T10:03:00.000Z")});
    getDb().prepare(`insert into learner_session_credits(id,source_learner_session_id,learner_id,app_id,credit_type,status,
      confirmed_by_actor_type,confirmed_by_actor_id,confirmation_reason_code,granted_at,expires_at,created_at,updated_at)
      values('credit-1',?,?,?,'technical_replacement','available','parent',?,'technical_issue',?,?,?,?)`)
      .run(first.sessionId,learners[0].id,"math-app",user.id,"2026-08-04T10:04:00.000Z","2026-09-04T10:04:00.000Z",
        "2026-08-04T10:04:00.000Z","2026-08-04T10:04:00.000Z");
    const credited=startLearnerSession(startInput(user.id,learners[0].id,{fundingSource:"technical_credit",creditId:"credit-1",
      scheduleAuthorized:false,idempotencyKey:"credit-start",now:new Date("2026-08-04T10:05:00.000Z")}));
    expect(credited).toMatchObject({source:"technical_credit",weeklySlotNumber:null});
    expect(getDb().prepare("select status,reserved_session_id from learner_session_credits where id='credit-1'").get())
      .toMatchObject({status:"reserved",reserved_session_id:credited.sessionId});
    expect(consumeTechnicalCredit("credit-1",credited.sessionId,new Date("2026-08-04T10:05:01.000Z"))).toMatchObject({status:"consumed"});
    expect(restoreTechnicalCredit("credit-1",credited.sessionId,new Date("2026-08-04T10:05:02.000Z"))).toBe(false);
    expect(getDb().prepare("select normal_sessions_started n from learner_app_week_usage").get()).toMatchObject({n:2});
  });
});

describe("SC-003 start reservation", () => {
  it("reserves without activating, then confirmUsableLaunch atomically activates, issues the envelope and starts the SC-001 clock", async () => {
    registerMathApp(); const { user, learners } = await fixture();
    getDb().prepare(`insert into app_service_principals(id,app_id,environment,deployment_id,client_id,key_ref,status,valid_from,valid_until,version)
      values('test-principal','math-app','production','60000000-0000-4000-8000-000000000001','client-math','test-key','active',?,?,1)`)
      .run("2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    const started = startLearnerSession(startInput(user.id, learners[0].id, { fundingSource: "standard_monthly" }));
    expect(started).toMatchObject({ status: "starting", source: "standard_monthly", weeklySessionOrdinal: 1 });
    expect(getDb().prepare("select funding_state,reserved_count,consumed_count from learner_sessions ls " +
      "join learner_app_standard_credit_batches b on b.id=ls.standard_credit_batch_id where ls.id=?").get(started.sessionId))
      .toMatchObject({ funding_state: "reserved", reserved_count: 1, consumed_count: 0 });
    expect(getDb().prepare("select standard_sessions_funded n from learner_app_week_usage").get()).toMatchObject({ n: 0 });

    const confirmed = await confirmUsableLaunch(ctx(started.sessionId, learners[0].id), {
      runtimeInitializationId: "runtime-1", runtimeVersion: 1, expectedSessionVersion: 1,
      idempotencyKey: "confirm-1", now: new Date("2026-08-04T10:00:20.000Z"),
    });
    expect(confirmed).toMatchObject({ sessionId: started.sessionId, status: "active",
      usableLaunchEstablishedAt: "2026-08-04T10:00:20.000Z", hardExpiresAt: "2026-08-04T11:00:20.000Z" });
    expect(typeof confirmed.sessionEnvelope).toBe("string");
    expect(getDb().prepare("select status,funding_state from learner_sessions where id=?").get(started.sessionId))
      .toMatchObject({ status: "active", funding_state: "consumed" });
    expect(getDb().prepare("select funding_state,reserved_count,consumed_count from learner_sessions ls " +
      "join learner_app_standard_credit_batches b on b.id=ls.standard_credit_batch_id where ls.id=?").get(started.sessionId))
      .toMatchObject({ reserved_count: 0, consumed_count: 1 });
    expect(getDb().prepare("select standard_sessions_funded n from learner_app_week_usage").get()).toMatchObject({ n: 1 });

    // exact retry returns the original result and never double-consumes
    const retry = await confirmUsableLaunch(ctx(started.sessionId, learners[0].id), {
      runtimeInitializationId: "runtime-1", runtimeVersion: 1, expectedSessionVersion: 1,
      idempotencyKey: "confirm-1", now: new Date("2026-08-04T10:00:21.000Z"),
    });
    expect(retry).toEqual(confirmed);
    expect(getDb().prepare("select consumed_count n from learner_app_standard_credit_batches").get()).toMatchObject({ n: 1 });

    // AN-001: a session starts only when the usable launch becomes active,
    // not when its five-minute reservation is created. The confirmation
    // retry must not increment the daily counter again.
    expect(getDb().prepare(
      "select sessions_started,engaged_seconds,sessions_interrupted from analytics_daily_buffer",
    ).get()).toMatchObject({ sessions_started: 1, engaged_seconds: 0, sessions_interrupted: 0 });

    const disconnected = disconnectLearnerSession(ctx(started.sessionId, learners[0].id), {
      reportedConnectedSeconds: 60, now: new Date("2026-08-04T10:01:20.000Z"),
    });
    expect(disconnected.status).toBe("disconnected");
    expect(getDb().prepare(
      "select sessions_started,engaged_seconds,sessions_interrupted from analytics_daily_buffer",
    ).get()).toMatchObject({ sessions_started: 1, engaged_seconds: 60, sessions_interrupted: 1 });

    // A repeated disconnect delivery is a no-op for both runtime state and
    // analytics counters.
    disconnectLearnerSession(ctx(started.sessionId, learners[0].id), {
      reportedConnectedSeconds: 60, now: new Date("2026-08-04T10:01:21.000Z"),
    });
    expect(getDb().prepare(
      "select sessions_started,engaged_seconds,sessions_interrupted from analytics_daily_buffer",
    ).get()).toMatchObject({ sessions_started: 1, engaged_seconds: 60, sessions_interrupted: 1 });

    resumeLearnerSession(ctx(started.sessionId, learners[0].id), {
      deviceSessionId: startInput(user.id, learners[0].id).deviceSessionId,
      credential: started.resumeCredential, now: new Date("2026-08-04T10:01:30.000Z"),
    });
    disconnectLearnerSession(ctx(started.sessionId, learners[0].id), {
      reportedConnectedSeconds: 100, now: new Date("2026-08-04T10:02:10.000Z"),
    });
    // The second cumulative report contributes only its newly accepted
    // 40-second delta, while counting a second interruption episode.
    expect(getDb().prepare(
      "select sessions_started,engaged_seconds,sessions_interrupted from analytics_daily_buffer",
    ).get()).toMatchObject({ sessions_started: 1, engaged_seconds: 100, sessions_interrupted: 2 });
  });

  it("expires an unconfirmed reservation after five minutes, releasing the learner lock and the credit without funding the week", async () => {
    registerMathApp(); const { user, learners } = await fixture();
    const started = startLearnerSession(startInput(user.id, learners[0].id, { fundingSource: "standard_monthly" }));
    await expect(confirmUsableLaunch(ctx(started.sessionId, learners[0].id), {
      runtimeInitializationId: "runtime-1", runtimeVersion: 1, expectedSessionVersion: 1,
      idempotencyKey: "confirm-late", now: new Date("2026-08-04T10:05:00.001Z"),
    })).rejects.toThrowError(new LearnerSessionError("SESSION_START_RESERVATION_EXPIRED"));
    expect(getDb().prepare("select status,funding_state from learner_sessions where id=?").get(started.sessionId))
      .toMatchObject({ status: "cancelled_before_launch", funding_state: "released" });
    expect(getDb().prepare("select reserved_count,consumed_count from learner_app_standard_credit_batches").get())
      .toMatchObject({ reserved_count: 0, consumed_count: 0 });
    expect(getDb().prepare("select standard_sessions_funded n from learner_app_week_usage").get()).toMatchObject({ n: 0 });
    // the learner lock is released — a new start succeeds immediately, no waiting for a scheduled job
    const retried = startLearnerSession(startInput(user.id, learners[0].id, { fundingSource: "standard_monthly",
      idempotencyKey: "50000000-0000-4000-8000-000000000099", now: new Date("2026-08-04T10:05:01.000Z") }));
    expect(retried.status).toBe("starting");
  });

  it("lets the learner explicitly cancel a starting reservation with the same release semantics as timeout", async () => {
    registerMathApp(); const { user, learners } = await fixture();
    const source = startLearnerSession(startInput(user.id, learners[0].id));
    markActive(source.sessionId);
    completeLearnerSession(source.sessionId, source.sessionToken, {
      deviceSessionId: startInput(user.id, learners[0].id).deviceSessionId, now: new Date("2026-08-04T10:01:00.000Z") });
    getDb().prepare(`insert into learner_session_credits(id,source_learner_session_id,learner_id,app_id,credit_type,status,
      confirmed_by_actor_type,confirmed_by_actor_id,confirmation_reason_code,granted_at,expires_at,created_at,updated_at)
      values('credit-1',?,?,'math-app','technical_replacement','available','parent',?,'technical_issue',?,?,?,?)`)
      .run(source.sessionId, learners[0].id, user.id, "2026-08-04T10:02:00.000Z", "2026-09-04T10:02:00.000Z",
        "2026-08-04T10:02:00.000Z", "2026-08-04T10:02:00.000Z");
    const started = startLearnerSession(startInput(user.id, learners[0].id, { fundingSource: "technical_credit",
      creditId: "credit-1", idempotencyKey: "50000000-0000-4000-8000-000000000097", now: new Date("2026-08-04T10:03:00.000Z") }));
    const cancelled = cancelStartReservation({ learnerId: learners[0].id, parentUserId: user.id }, started.sessionId,
      { expectedSessionVersion: 1, now: new Date("2026-08-04T10:01:00.000Z") });
    expect(cancelled).toEqual({ sessionId: started.sessionId, status: "cancelled_before_launch" });
    expect(getDb().prepare("select status from learner_session_credits where id='credit-1'").get())
      .toMatchObject({ status: "available" });
    // idempotent: cancelling again just returns the same final state
    expect(cancelStartReservation({ learnerId: learners[0].id, parentUserId: user.id }, started.sessionId,
      { expectedSessionVersion: 1, now: new Date("2026-08-04T10:02:00.000Z") })).toEqual(cancelled);
  });

  it("sweeps expired starting reservations that nobody retried, without touching a still-live one", async () => {
    registerMathApp(); const { user, learners } = await fixture(2);
    const stale = startLearnerSession(startInput(user.id, learners[0].id, { fundingSource: "standard_monthly" }));
    const live = startLearnerSession(startInput(user.id, learners[1].id, { fundingSource: "standard_monthly",
      idempotencyKey: "50000000-0000-4000-8000-000000000098", now: new Date("2026-08-04T10:04:00.000Z") }));
    expect(sweepExpiredStartReservations(new Date("2026-08-04T10:05:00.001Z"))).toBe(1);
    expect(getDb().prepare("select status from learner_sessions where id=?").get(stale.sessionId))
      .toMatchObject({ status: "cancelled_before_launch" });
    expect(getDb().prepare("select status from learner_sessions where id=?").get(live.sessionId))
      .toMatchObject({ status: "starting" });
  });
});
