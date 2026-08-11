// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { recomputeEffectiveEntitlement } from "@/lib/entitlement-access/service";
import { LearnerSessionError, startLearnerSession } from "@/lib/learning-session/gateway";
import { scheduleMaintenanceWindow } from "@/lib/app-availability/service";

const now = new Date("2026-08-11T10:00:00.000Z");
beforeEach(() => { useInMemoryDb(); process.env.LEARNING_SESSION_SECRET = "ul004-learning-session-secret-32-bytes"; });

async function fixture() {
  const { user } = await sqliteAuthAdapter.signUp(`ul004-${randomUUID()}@example.com`, "CorrectHorse1!");
  const learner = createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01").learner;
  getDb().prepare(`insert into app_registry(id,app_key,display_name,registry_status) values('app-1','app-1','App 1','active')`).run();
  getDb().prepare(`insert into entitlement_cycles(id,paid_cycle_id,subscription_id,purchaser_parent_id,assigned_learner_id,
    product_id,product_version,app_ids_json,period_start,period_end,billing_anchor,status,source_event_id,
    source_event_version,source_event_hash,created_at,ready_at,version)
    values('cycle','cycle','sub',?,?,'product',1,'["app-1"]','2026-08-01T00:00:00Z','2026-09-01T00:00:00Z',
    '2026-08-01','ready','event',1,'hash',?,?,1)`).run(user.id, learner.id, now.toISOString(), now.toISOString());
  getDb().prepare(`insert into learner_app_entitlement_periods(id,entitlement_cycle_id,subscription_id,learner_id,app_id,
    product_version,period_start,period_end,status,effective_source_role,created_at)
    values('period','cycle','sub',?,'app-1',1,'2026-08-01T00:00:00Z','2026-09-01T00:00:00Z','ready','allocation_bearing',?)`)
    .run(learner.id, now.toISOString());
  recomputeEffectiveEntitlement({ learnerId: learner.id, appId: "app-1", environment: "production", now });
  return { user, learner };
}

describe("UL-004 SC-003 transaction gate", () => {
  it("denies stale-card Start before reservation, funding, weekly use, or technical credit mutation", async () => {
    const { user, learner } = await fixture();
    scheduleMaintenanceWindow({ appId: "app-1", environment: "production",
      startsAt: new Date(now.getTime() + 3_899_000), endsAt: new Date(now.getTime() + 7_200_000),
      reasonCategory: "planned", expectedAvailabilityVersion: 1, idempotencyKey: "window", actorId: user.id }, now);
    expect(() => startLearnerSession({ actorSessionId: "parent-session", parentUserId: user.id,
      selectedLearnerId: learner.id, learnerId: learner.id, appId: "app-1", deviceSessionId: "device-1",
      scheduleAuthorizationId: "schedule-1", scheduleAuthorized: true, idempotencyKey: "start-1", now,
      deployment: { deploymentId: "deployment-1", releaseId: "release-1", environment: "production",
        origin: "https://app.example", launchPath: "/launch", compatibilityPassed: true, dispatchBlocked: false } }))
      .toThrowError(new LearnerSessionError("APP_MAINTENANCE_SOON"));
    for (const table of ["learner_sessions", "session_start_requests", "learner_app_week_usage"]) {
      expect((getDb().prepare(`select count(*) count from ${table}`).get() as { count: number }).count).toBe(0);
    }
  });
});
