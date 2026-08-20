import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { applyPaidCycle } from "@/lib/entitlement-cycle/service";
import { defineProductVersion } from "@/lib/billing/bi001-service";
import { applyLifecycleEvent } from "@/lib/entitlement-lifecycle/service";
import { EntitlementLifecycleError } from "@/lib/entitlement-lifecycle/errors";
import { startLearnerSession } from "@/lib/learning-session/gateway";

const APP_ID = "app-en003-math";
let parentId: string;
let learnerId: string;

function effectiveRow(appId = APP_ID) {
  return getDb().prepare(
    "select * from learner_app_effective_entitlements where learner_id=? and app_id=?",
  ).get(learnerId, appId) as any;
}

function grantCoveringPeriod(now = new Date("2026-08-01T00:00:00.000Z")) {
  return applyPaidCycle({
    paidCycleId: `cycle-${randomUUID()}`, eventId: `event-${randomUUID()}`, eventVersion: 1,
    subscriptionId: `sub-${randomUUID()}`, purchaserParentId: parentId, assignedLearnerId: learnerId,
    productId: "product-1", productVersion: 1, appIds: [APP_ID],
    periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z",
    billingAnchor: "2026-08-01", environment: "production", now,
  });
}

beforeEach(async () => {
  useInMemoryDb();
  process.env.LEARNING_SESSION_SECRET = "en003-test-secret-that-is-at-least-32-chars-long";
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,
    owning_team,registry_status) values(?,?,'Math App','Math','icon-abacus','learning','team','active')`)
    .run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("en003-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = (await createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "50000000-0000-4000-8000-000000000001" }, "2026-08-01")).learner.id;
});

describe("EN-003 applyLifecycleEvent — security revocation (rules 56-57)", () => {
  it("suspends access immediately and revokes an active session", () => {
    grantCoveringPeriod();
    const now = new Date("2026-08-05T10:00:00.000Z");
    const session = startLearnerSession({ actorSessionId: "parent-session", parentUserId: parentId,
      selectedLearnerId: learnerId, learnerId, appId: APP_ID, deviceSessionId: "device-1",
      scheduleAuthorizationId: "schedule-1", scheduleAuthorized: true, idempotencyKey: "start-1",
      now, fundingSource: "standard_monthly",
      deployment: { deploymentId: "deployment-1", releaseId: "release-1", environment: "production",
        origin: "https://math.example.test", launchPath: "/launch", compatibilityPassed: true,
        dispatchBlocked: false } }) as any;
    getDb().prepare(
      `update learner_sessions set status='active',funding_state='consumed',usable_launch_established_at=?,
       hard_expires_at=?,active_segment_started_at=?,version=version+1 where id=?`,
    ).run(now.toISOString(), new Date(now.getTime() + 3600_000).toISOString(), now.toISOString(), session.sessionId);

    const result = applyLifecycleEvent({
      eventId: "security-1", eventType: "security_revoked", source: "platform_security",
      sourceVersion: 1, effectiveAt: now.toISOString(),
      sourceReference: { learnerId, appId: APP_ID, reasonCategory: "security_admin_action", fraudOrSecurityRisk: true },
      now,
    });

    expect(result.status).toBe("applied");
    expect(result.affected).toEqual([expect.objectContaining({
      learnerId, appId: APP_ID, previousState: "active", newState: "suspended_security",
      sessionEffect: "immediate_revoke",
    })]);
    const row = effectiveRow();
    expect(row.state).toBe("suspended_security");
    expect(row.lifecycle_version).toBe(1);
    expect(row.revoked_before).toBe(now.toISOString());

    const sessionRow = getDb().prepare("select status,end_reason from learner_sessions where id=?")
      .get(session.sessionId) as any;
    expect(sessionRow.status).toBe("revoked_by_admin");
    expect(sessionRow.end_reason).toBe("lifecycle:security_revoked");

    const transitions = getDb().prepare("select * from entitlement_state_transitions where effective_entitlement_id=?")
      .all(row.id) as any[];
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ previous_state: "active", new_state: "suspended_security",
      session_effect: "immediate_revoke", result: "applied" });
  });

  it("cancels only a starting reservation, leaving an active session to finish (preserve_to_hard_expiry)", () => {
    grantCoveringPeriod();
    const now = new Date("2026-08-05T10:00:00.000Z");
    startLearnerSession({ actorSessionId: "parent-session", parentUserId: parentId,
      selectedLearnerId: learnerId, learnerId, appId: APP_ID, deviceSessionId: "device-2",
      scheduleAuthorizationId: "schedule-2", scheduleAuthorized: true, idempotencyKey: "start-2",
      now, fundingSource: "standard_monthly",
      deployment: { deploymentId: "deployment-1", releaseId: "release-1", environment: "production",
        origin: "https://math.example.test", launchPath: "/launch", compatibilityPassed: true,
        dispatchBlocked: false } });

    const result = applyLifecycleEvent({
      eventId: "cancel-audit-1", eventType: "cancellation_effective", source: "billing_cancellation",
      sourceVersion: 1, effectiveAt: now.toISOString(),
      sourceReference: { learnerId, appId: APP_ID, reasonCategory: "self_service" },
      now,
    });

    expect(result.affected[0].sessionEffect).toBe("preserve_to_hard_expiry");
    const starting = getDb().prepare("select status from learner_sessions where app_id=?").get(APP_ID) as any;
    expect(starting.status).toBe("cancelled_before_launch");
  });
});

describe("EN-003 applyLifecycleEvent — idempotency and conflicts (rules 61-63)", () => {
  it("returns the original result for an exact duplicate event", () => {
    grantCoveringPeriod();
    const now = new Date("2026-08-05T10:00:00.000Z");
    const input = { eventId: "dup-1", eventType: "security_revoked" as const, source: "platform_security" as const,
      sourceVersion: 1, effectiveAt: now.toISOString(),
      sourceReference: { learnerId, appId: APP_ID, reasonCategory: "security_admin_action" }, now };
    const first = applyLifecycleEvent(input);
    const second = applyLifecycleEvent(input);
    expect(second).toEqual(first);
    const transitions = getDb().prepare("select count(*) n from entitlement_state_transitions").get() as any;
    expect(transitions.n).toBe(1);
  });

  it("rejects a different payload reusing the same event id", () => {
    grantCoveringPeriod();
    const now = new Date("2026-08-05T10:00:00.000Z");
    applyLifecycleEvent({ eventId: "reuse-1", eventType: "security_revoked", source: "platform_security",
      sourceVersion: 1, effectiveAt: now.toISOString(),
      sourceReference: { learnerId, appId: APP_ID, reasonCategory: "security_admin_action" }, now });
    expect(() => applyLifecycleEvent({ eventId: "reuse-1", eventType: "security_revoked", source: "platform_security",
      sourceVersion: 1, effectiveAt: now.toISOString(),
      sourceReference: { learnerId, appId: APP_ID, reasonCategory: "different_reason" }, now }))
      .toThrow(new EntitlementLifecycleError("ENTITLEMENT_LIFECYCLE_CONFLICT"));
  });

  it("rejects a stale sourceVersion for the same subscription", () => {
    const productId = defineProductVersion({ id: "product-en003-1", slug: "en003-monthly", name: "Math Monthly",
      subdomain: "en003.example.test", planReference: "plan-en003", priceInr: 299,
      productType: "individual_app", version: 1, appIds: [APP_ID] }).id;
    const subscriptionId = `sub-${randomUUID()}`;
    getDb().prepare(
      `insert into subscriptions(id,user_id,type,product_id,purchaser_parent_id,assigned_learner_id,product_version,
       razorpay_subscription_id,current_period_end) values(?,?,?,?,?,?,?,?,?)`,
    ).run(subscriptionId, parentId, "single", productId, parentId, learnerId, 1,
      `razorpay-${subscriptionId}`, "2026-09-01T00:00:00.000Z");
    grantCoveringPeriod();
    const now = new Date("2026-08-05T10:00:00.000Z");
    applyLifecycleEvent({ eventId: "cancel-v2", eventType: "cancellation_effective", source: "billing_cancellation",
      sourceVersion: 2, effectiveAt: now.toISOString(),
      sourceReference: { subscriptionId, learnerId, reasonCategory: "self_service" }, now });
    expect(() => applyLifecycleEvent({ eventId: "cancel-v1", eventType: "cancellation_effective",
      source: "billing_cancellation", sourceVersion: 1, effectiveAt: now.toISOString(),
      sourceReference: { subscriptionId, learnerId, reasonCategory: "self_service" }, now }))
      .toThrow(new EntitlementLifecycleError("ENTITLEMENT_LIFECYCLE_VERSION_CONFLICT"));
  });

  it("quarantines a conflicting event at the same sourceVersion", () => {
    const productId = defineProductVersion({ id: "product-en003-2", slug: "en003-monthly-2", name: "Math Monthly 2",
      subdomain: "en003b.example.test", planReference: "plan-en003b", priceInr: 299,
      productType: "individual_app", version: 1, appIds: [APP_ID] }).id;
    const subscriptionId = `sub-${randomUUID()}`;
    getDb().prepare(
      `insert into subscriptions(id,user_id,type,product_id,purchaser_parent_id,assigned_learner_id,product_version,
       razorpay_subscription_id,current_period_end) values(?,?,?,?,?,?,?,?,?)`,
    ).run(subscriptionId, parentId, "single", productId, parentId, learnerId, 1,
      `razorpay-${subscriptionId}`, "2026-09-01T00:00:00.000Z");
    grantCoveringPeriod();
    const now = new Date("2026-08-05T10:00:00.000Z");
    applyLifecycleEvent({ eventId: "conflict-a", eventType: "cancellation_effective", source: "billing_cancellation",
      sourceVersion: 1, effectiveAt: now.toISOString(),
      sourceReference: { subscriptionId, learnerId, reasonCategory: "self_service" }, now });
    expect(() => applyLifecycleEvent({ eventId: "conflict-b", eventType: "cancellation_effective",
      source: "billing_cancellation", sourceVersion: 1, effectiveAt: now.toISOString(),
      sourceReference: { subscriptionId, learnerId, reasonCategory: "self_service" }, now }))
      .toThrow(new EntitlementLifecycleError("ENTITLEMENT_LIFECYCLE_CONFLICT"));
    const quarantined = getDb().prepare("select status,quarantine_reason from entitlement_lifecycle_events where event_id='conflict-b'")
      .get() as any;
    expect(quarantined).toMatchObject({ status: "quarantined", quarantine_reason: "CONFLICTING_SOURCE_VERSION" });
  });
});

describe("EN-003 applyLifecycleEvent — audit-only transitions (rule 8/68)", () => {
  it("records a transition row without changing state for refund_partial_no_change", () => {
    grantCoveringPeriod();
    const now = new Date("2026-08-05T10:00:00.000Z");
    const before = effectiveRow();
    const result = applyLifecycleEvent({
      eventId: "partial-1", eventType: "refund_partial_no_change", source: "billing_refund",
      sourceVersion: 1, effectiveAt: now.toISOString(),
      sourceReference: { refundCaseId: "refund-case-1", learnerId, appId: APP_ID, reasonCategory: "partial_refund",
        policyEffect: "no_change" },
      now,
    });
    expect(result.affected[0]).toMatchObject({ previousState: "active", newState: "active", sessionEffect: "none" });
    const after = effectiveRow();
    expect(after.state).toBe(before.state);
    expect(after.lifecycle_version).toBe(1);
  });
});
