// @vitest-environment node
import { registerProgressSchema } from "@/lib/progress-schema-registry/service";
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


// PRG-037 (issue #58): learning launch is gated by progress integrity for mandatory-progress apps; a blocked launch consumes nothing.
describe("PRG-037 learning launch integrity gate", () => {
  async function started(corrupt: boolean) {
    registerMathApp(); const { user, learners } = await fixture();
    getDb().prepare(`insert into app_service_principals(id,app_id,environment,deployment_id,client_id,key_ref,status,valid_from,valid_until,version)
      values('test-principal','math-app','production','60000000-0000-4000-8000-000000000001','client-math','test-key','active',?,?,1)`)
      .run("2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    const session = await startLearnerSession(startInput(user.id, learners[0].id, { fundingSource: "standard_monthly" }));
    const releaseId = (getDb().prepare("select release_id r from learner_sessions where id=?").get(session.sessionId) as { r: string | null }).r;
    if (releaseId) await registerProgressSchema({ appId: "math-app", releaseId, schemaVersion: 1, schemaJson: '{"type":"object"}', now: new Date("2026-08-04T10:00:00.000Z") });
    if (corrupt) {
      getDb().prepare(`insert into learner_app_progress(learner_id,app_id,schema_version,current_state_json,progress_version,state_hash,updated_at)
        values(?,?,1,?,1,'not-the-real-hash',?)`).run(learners[0].id, "math-app", JSON.stringify({ level: "tampered" }), "2026-08-04T10:00:00.000Z");
    }
    return { user, learner: learners[0], session, releaseId };
  }
  const confirm = (s: Awaited<ReturnType<typeof started>>) => confirmUsableLaunch(ctx(s.session.sessionId, s.learner.id), {
    runtimeInitializationId: "runtime-1", runtimeVersion: 1, expectedSessionVersion: 1, idempotencyKey: "confirm-1", now: new Date("2026-08-04T10:00:20.000Z") });

  it("corrupted progress blocks usable launch and rolls everything back (session still starting, credit still reserved, nothing consumed)", async () => {
    const s = await started(true);
    expect(s.releaseId).toBeTruthy();                            // the gate only applies to a release with a registered progress schema
    await expect(confirm(s)).rejects.toMatchObject({ code: "PROGRESS_INTEGRITY_LAUNCH_BLOCKED" });
    expect(getDb().prepare("select status,funding_state from learner_sessions where id=?").get(s.session.sessionId)).toMatchObject({ status: "starting", funding_state: "reserved" });
    expect(getDb().prepare("select reserved_count,consumed_count from learner_app_standard_credit_batches").get()).toMatchObject({ reserved_count: 1, consumed_count: 0 });
    expect(getDb().prepare("select standard_sessions_funded n from learner_app_week_usage").get()).toMatchObject({ n: 0 });
  });

  it("healthy (or absent) progress launches normally", async () => {
    const s = await started(false);
    await expect(confirm(s)).resolves.toMatchObject({ status: "active" });
  });
});
