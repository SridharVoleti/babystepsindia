// @vitest-environment node
// GAP-018: LP-002's date-of-birth change and weekly-use preservation
// interact with the full session lifecycle (LP-004 start -> SC-003 confirm
// -> AN-001 analytics contribution) — this cross-requirement integration
// test exercises that combination now that the session-runtime gaps it was
// blocked on (SC-001, IA-004, PR-001/002/003) are built.
import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { createLearner, updateLearner } from "@/lib/db/learner-repo";
import { deriveAgeBand } from "@/lib/analytics/age-band";
import { recomputeEffectiveEntitlement } from "@/lib/entitlement-access/service";
import { completeLearnerSession, confirmUsableLaunch, startLearnerSession } from "@/lib/learning-session/gateway";

const appId = "math-app";

const envelopeKeys = generateKeyPairSync("ed25519");

beforeEach(() => {
  useInMemoryDb();
  process.env.LEARNING_SESSION_SECRET = "test-only-learning-session-secret-32-bytes";
  process.env.ANALYTICS_HMAC_SECRET = "analytics-test-secret-at-least-32-characters";
  process.env.SESSION_ENVELOPE_SIGNING_PRIVATE_KEY = envelopeKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.SESSION_ENVELOPE_SIGNING_PUBLIC_KEY = envelopeKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,registry_status) values(?,?,?,'active')`)
    .run(appId, appId, "Math App");
});

function seedEntitlement(parentId: string, learnerId: string) {
  const db = getDb();
  const cycleId = `cycle-${learnerId}`;
  db.prepare(`insert into entitlement_cycles(id,paid_cycle_id,subscription_id,purchaser_parent_id,
    assigned_learner_id,product_id,product_version,app_ids_json,period_start,period_end,billing_anchor,
    status,source_event_id,source_event_version,source_event_hash,created_at,ready_at,version)
    values(?,?,?,?,?,'product-fixture',1,'[]','2020-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z',
    '2020-01-01','ready',?,1,'hash',?,?,1)`)
    .run(cycleId, cycleId, `sub-${cycleId}`, parentId, learnerId, `event-${cycleId}`,
      "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
  db.prepare(`insert into learner_app_entitlement_periods(id,entitlement_cycle_id,subscription_id,learner_id,
    app_id,product_version,period_start,period_end,status,effective_source_role,created_at)
    values(?,?,?,?,?,1,'2020-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z','ready','allocation_bearing',?)`)
    .run(`period-${learnerId}`, cycleId, `sub-${cycleId}`, learnerId, appId, "2020-01-01T00:00:00.000Z");
  recomputeEffectiveEntitlement({ learnerId, appId, environment: "production", now: new Date("2026-08-04T10:00:00.000Z") });
}

function startInput(parentId: string, learnerId: string, idempotencyKey: string, now: Date) {
  return {
    actorSessionId: "30000000-0000-4000-8000-000000000001", parentUserId: parentId,
    selectedLearnerId: learnerId, learnerId, appId, deviceSessionId: "40000000-0000-4000-8000-000000000001",
    scheduleAuthorizationId: "schedule-1", scheduleAuthorized: true, idempotencyKey, now,
    deployment: { deploymentId: "60000000-0000-4000-8000-000000000001", releaseId: "70000000-0000-4000-8000-000000000001",
      environment: "production", origin: "https://math.example", launchPath: "/launch",
      compatibilityPassed: true, dispatchBlocked: false },
  };
}

describe("GAP-018: LP-002 date-of-birth change across the full session lifecycle", () => {
  it("preserves weekly session-slot usage across a mid-week date-of-birth change", async () => {
    const { user } = await sqliteAuthAdapter.signUp("gap018-parent@example.com", "CorrectHorse1!");
    getDb().prepare("update profiles set onboarding_status='complete' where id=?").run(user.id);
    const learner = createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
      idempotencyKey: crypto.randomUUID() }, "2026-08-04").learner;
    seedEntitlement(user.id, learner.id);
    getDb().prepare(`insert into app_service_principals(id,app_id,environment,deployment_id,client_id,key_ref,status,valid_from,valid_until,version)
      values('test-principal',?,'production','60000000-0000-4000-8000-000000000001','client-math','test-key','active',?,?,1)`)
      .run(appId, "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");

    const first = startLearnerSession(startInput(user.id, learner.id, crypto.randomUUID(), new Date("2026-08-04T10:00:00.000Z")));
    expect(first.weeklySlotNumber).toBe(1);

    // A parent updates the learner's date of birth mid-week — this must
    // not reset, bypass or otherwise perturb the weekly slot count, which
    // is keyed by learner_id/app_id/week_key, independent of the learner's
    // profile fields.
    updateLearner(user.id, learner.id, { dateOfBirth: "2016-01-01", expectedVersion: learner.version,
      idempotencyKey: crypto.randomUUID() }, "2026-08-04");

    const second = startLearnerSession(startInput(user.id, learner.id, crypto.randomUUID(), new Date("2026-08-04T11:00:00.000Z")));
    expect(second.weeklySlotNumber).toBe(2);

    // The weekly limit (2 normal sessions) is still enforced after the DOB
    // change — a third start in the same week is rejected exactly as it
    // would have been without the change.
    expect(() => startLearnerSession(startInput(user.id, learner.id, crypto.randomUUID(), new Date("2026-08-04T12:00:00.000Z"))))
      .toThrow();
  });

  it("attributes analytics contributions to the age band in effect at the moment of each contribution, not retroactively", async () => {
    const { user } = await sqliteAuthAdapter.signUp("gap018-parent-2@example.com", "CorrectHorse1!");
    getDb().prepare("update profiles set onboarding_status='complete' where id=?").run(user.id);
    // Old enough that a later DOB correction moves them into a different
    // age band outright (not just a birthday-adjacent edge case).
    const learner = createLearner(user.id, { displayName: "Rohan", dateOfBirth: "2010-01-01",
      idempotencyKey: crypto.randomUUID() }, "2026-08-04").learner;
    seedEntitlement(user.id, learner.id);
    getDb().prepare(`insert into app_service_principals(id,app_id,environment,deployment_id,client_id,key_ref,status,valid_from,valid_until,version)
      values('test-principal',?,'production','60000000-0000-4000-8000-000000000001','client-math','test-key','active',?,?,1)`)
      .run(appId, "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");

    const beforeBand = deriveAgeBand("2010-01-01", "2026-08-04");
    const started = startLearnerSession(startInput(user.id, learner.id, crypto.randomUUID(), new Date("2026-08-04T10:00:00.000Z")));
    const confirmContext = { grantId: "test-grant", principalId: "test-principal", learnerSessionId: started.sessionId,
      learnerId: learner.id, appId };
    const firstVersion = (getDb().prepare("select version from learner_sessions where id=?").get(started.sessionId) as { version: number }).version;
    await confirmUsableLaunch(confirmContext, { runtimeInitializationId: "runtime-1", runtimeVersion: 1,
      expectedSessionVersion: firstVersion, idempotencyKey: "confirm-1", now: new Date("2026-08-04T10:00:05.000Z") });

    const bandsAfterFirstSession = getDb().prepare("select distinct age_band from analytics_daily_buffer").all() as
      Array<{ age_band: string }>;
    expect(bandsAfterFirstSession.map((r) => r.age_band)).toEqual([beforeBand]);
    completeLearnerSession(started.sessionId, started.sessionToken,
      { deviceSessionId: "40000000-0000-4000-8000-000000000001", now: new Date("2026-08-04T10:00:10.000Z") });

    // Correcting the date of birth moves the learner into a different age
    // band going forward.
    updateLearner(user.id, learner.id, { dateOfBirth: "2005-01-01", expectedVersion: learner.version,
      idempotencyKey: crypto.randomUUID() }, "2026-08-04");
    const afterBand = deriveAgeBand("2005-01-01", "2026-08-11");
    expect(afterBand).not.toBe(beforeBand);

    const secondStart = startLearnerSession(startInput(user.id, learner.id, crypto.randomUUID(), new Date("2026-08-11T10:00:00.000Z")));
    const secondVersion = (getDb().prepare("select version from learner_sessions where id=?").get(secondStart.sessionId) as { version: number }).version;
    await confirmUsableLaunch({ ...confirmContext, learnerSessionId: secondStart.sessionId },
      { runtimeInitializationId: "runtime-2", runtimeVersion: 1, expectedSessionVersion: secondVersion,
        idempotencyKey: "confirm-2", now: new Date("2026-08-11T10:00:05.000Z") });

    const bandsAfterSecondSession = getDb().prepare("select distinct age_band from analytics_daily_buffer").all() as
      Array<{ age_band: string }>;
    // The first day's row still reflects the age band captured at the time
    // (an immutable historical record); the new day's row reflects the
    // corrected date of birth. Both are present — neither was overwritten.
    expect(new Set(bandsAfterSecondSession.map((r) => r.age_band))).toEqual(new Set([beforeBand, afterBand]));
  });
});
