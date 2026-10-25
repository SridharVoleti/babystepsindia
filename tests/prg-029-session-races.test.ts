// @vitest-environment node
import { vi } from "vitest";
import { resolveDbClient } from "@/lib/db-client";
import { generateKeyPairSync } from "node:crypto";
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
  revokeActiveLearnerSessionsForParent,
  selectLearner,
  startLearnerSession,
  sweepExpiredLearnerSessions,
  sweepExpiredStartReservations,
} from "@/lib/learning-session/gateway";
import { isoWeekKey } from "@/lib/learning-session/week";
import { consumeTechnicalCredit, restoreTechnicalCredit } from "@/lib/session-credit/service";
import { recomputeEffectiveEntitlement } from "@/lib/entitlement-access/service";
import { computeCanonicalStateHash } from "@/lib/progress-integrity/service";

const envelopeKeys = generateKeyPairSync("ed25519");

beforeEach(() => {
  useInMemoryDb();
  process.env.LEARNING_SESSION_SECRET = "test-only-learning-session-secret-32-bytes";
  process.env.ANALYTICS_HMAC_SECRET = "analytics-test-secret-at-least-32-characters";
  process.env.SESSION_ENVELOPE_SIGNING_PRIVATE_KEY = envelopeKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.SESSION_ENVELOPE_SIGNING_PUBLIC_KEY = envelopeKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
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
async function seedEntitlement(parentId: string, learnerId: string, appId: string, environment = "production") {
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
  await recomputeEffectiveEntitlement({ learnerId, appId, environment, now: new Date("2026-08-04T10:00:00.000Z") });
}

async function fixture(learnerCount = 1) {
  registerMathApp();
  const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
  getDb().prepare("update profiles set onboarding_status='learner_pending' where id=?").run(user.id);
  const learners = [];
  for (let index = 0; index < learnerCount; index++) {
    learners.push((await createLearner(user.id, {
      displayName: `Learner ${index + 1}`,
      dateOfBirth: "2018-01-01",
      idempotencyKey: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }, "2026-08-04")).learner);
  }
  for (const learner of learners) {
    await seedEntitlement(user.id, learner.id, "math-app");
    await seedEntitlement(user.id, learner.id, "chess-app");
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


// PRG-029 (issue #59): the SC-001/SC-003 session lifecycle under races. A concurrent transaction's stale reads are served deterministically.
const n = (sql: string, ...a: unknown[]) => (getDb().prepare(sql).get(...a) as { n: number }).n;

function stale(match: RegExp, value: unknown, times = 1) {
  const client = resolveDbClient(); const real = client.get.bind(client); let left = times;
  return vi.spyOn(client, "get").mockImplementation((async (sql: string, params?: unknown[]) => {
    if (left > 0 && match.test(sql)) { left -= 1; return value; }
    return real(sql, params as never);
  }) as never);
}
const principal = () => getDb().prepare(`insert into app_service_principals(id,app_id,environment,deployment_id,client_id,key_ref,status,valid_from,valid_until,version)
  values('test-principal','math-app','production','60000000-0000-4000-8000-000000000001','client-math','test-key','active',?,?,1)`)
  .run("2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
const confirmArgs = { runtimeInitializationId: "runtime-1", runtimeVersion: 1, expectedSessionVersion: 1, idempotencyKey: "confirm-1" };

describe("PRG-029 simultaneous start attempts", () => {
  it("a second start that passed the in-progress check concurrently gets LEARNER_SESSION_IN_PROGRESS, not a raw constraint error, and reserves nothing", async () => {
    registerMathApp(); const { user, learners } = await fixture();
    principal();
    await startLearnerSession(startInput(user.id, learners[0].id, { fundingSource: "standard_monthly" }));
    const reservedBefore = n("select reserved_count n from learner_app_standard_credit_batches");
    const spy = stale(/from learner_sessions where learner_id=\? and status in/, undefined);
    await expect(startLearnerSession(startInput(user.id, learners[0].id, { fundingSource: "standard_monthly",
      idempotencyKey: "50000000-0000-4000-8000-000000000002", deviceSessionId: "40000000-0000-4000-8000-000000000002" })))
      .rejects.toMatchObject({ code: "LEARNER_SESSION_IN_PROGRESS" });
    spy.mockRestore();
    expect(n("select count(*) n from learner_sessions")).toBe(1);
    expect(n("select reserved_count n from learner_app_standard_credit_batches")).toBe(reservedBefore);
  });

  it("a duplicate start with the same idempotency key replays the original session even when both passed the replay check", async () => {
    registerMathApp(); const { user, learners } = await fixture();
    const input = startInput(user.id, learners[0].id, { fundingSource: "standard_monthly" });
    const first = await startLearnerSession(input);
    const spy = stale(/from session_start_requests/, undefined);
    const spy2 = stale(/from learner_sessions where learner_id=\? and status in/, undefined);
    const second = await startLearnerSession(input);
    spy.mockRestore(); spy2.mockRestore();
    expect(second.sessionId).toBe(first.sessionId);
    expect(n("select count(*) n from learner_sessions")).toBe(1);
  });

  it("a normal-source start that lost the weekly-slot race is WEEKLY_SESSION_LIMIT_REACHED", async () => {
    registerMathApp(); const { user, learners } = await fixture();
    const start = (k: number, at: string) => startLearnerSession(startInput(user.id, learners[0].id,
      { idempotencyKey: `50000000-0000-4000-8000-00000000010${k}`, deviceSessionId: `40000000-0000-4000-8000-00000000010${k}`, now: new Date(at) }));
    const a = await start(1, "2026-08-04T10:00:00.000Z"); getDb().prepare("update learner_sessions set status='completed' where id=?").run(a.sessionId);
    const b = await start(2, "2026-08-04T11:00:00.000Z"); getDb().prepare("update learner_sessions set status='completed' where id=?").run(b.sessionId);
    const spy = stale(/from learner_app_week_usage where learner_id=\? and app_id=\? and week_key=\?/, { normal_sessions_started: 1 });
    await expect(start(3, "2026-08-04T12:00:00.000Z")).rejects.toMatchObject({ code: "WEEKLY_SESSION_LIMIT_REACHED" });
    spy.mockRestore();
    expect(n("select count(*) n from learner_sessions")).toBe(2);
  });
});

describe("PRG-029 duplicate usable-launch confirmation", () => {
  it("a duplicate that missed the receipt replays the original result: exactly one active session and one consumption", async () => {
    registerMathApp(); const { user, learners } = await fixture(); principal();
    const started = await startLearnerSession(startInput(user.id, learners[0].id, { fundingSource: "standard_monthly" }));
    const first = await confirmUsableLaunch(ctx(started.sessionId, learners[0].id), { ...confirmArgs, now: new Date("2026-08-04T10:00:20.000Z") });
    const spy = stale(/from usable_launch_requests/, undefined);
    const second = await confirmUsableLaunch(ctx(started.sessionId, learners[0].id), { ...confirmArgs, now: new Date("2026-08-04T10:00:21.000Z") });
    spy.mockRestore();
    expect(second).toEqual(first);
    expect(n("select count(*) n from learner_sessions where status='active'")).toBe(1);
    expect(n("select consumed_count n from learner_app_standard_credit_batches")).toBe(1);
  });

  it("a conflicting confirmation (different idempotency key) after activation is rejected without side effects", async () => {
    registerMathApp(); const { user, learners } = await fixture(); principal();
    const started = await startLearnerSession(startInput(user.id, learners[0].id, { fundingSource: "standard_monthly" }));
    await confirmUsableLaunch(ctx(started.sessionId, learners[0].id), { ...confirmArgs, now: new Date("2026-08-04T10:00:20.000Z") });
    await expect(confirmUsableLaunch(ctx(started.sessionId, learners[0].id), { ...confirmArgs, idempotencyKey: "confirm-2", now: new Date("2026-08-04T10:00:22.000Z") }))
      .rejects.toMatchObject({ code: "USABLE_LAUNCH_ALREADY_CONFIRMED" });
    expect(n("select consumed_count n from learner_app_standard_credit_batches")).toBe(1);
  });

  it("an expired reservation cannot be confirmed and its credit is released", async () => {
    registerMathApp(); const { user, learners } = await fixture(); principal();
    const started = await startLearnerSession(startInput(user.id, learners[0].id, { fundingSource: "standard_monthly" }));
    await expect(confirmUsableLaunch(ctx(started.sessionId, learners[0].id), { ...confirmArgs, now: new Date("2026-08-04T10:06:00.000Z") }))
      .rejects.toMatchObject({ code: "SESSION_START_RESERVATION_EXPIRED" });
    expect(n("select consumed_count n from learner_app_standard_credit_batches")).toBe(0);
    expect(n("select reserved_count n from learner_app_standard_credit_batches")).toBe(0);
  });

  it("a confirmation by another learner's context is rejected (session binding)", async () => {
    registerMathApp(); const { user, learners } = await fixture(2); principal();
    const started = await startLearnerSession(startInput(user.id, learners[0].id, { fundingSource: "standard_monthly" }));
    await expect(confirmUsableLaunch(ctx(started.sessionId, learners[1].id), { ...confirmArgs, now: new Date("2026-08-04T10:00:20.000Z") }))
      .rejects.toMatchObject({ code: "LEARNER_SESSION_BINDING_MISMATCH" });
    expect(n("select count(*) n from learner_sessions where status='active'")).toBe(0);
  });
});
