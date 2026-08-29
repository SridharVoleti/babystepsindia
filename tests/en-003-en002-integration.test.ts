import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { defineProductVersion } from "@/lib/billing/bi001-service";
import { applyPaidCycle } from "@/lib/entitlement-cycle/service";
import { applyLifecycleEvent } from "@/lib/entitlement-lifecycle/service";
import { reconcileEntitlementLifecycle } from "@/lib/entitlement-lifecycle/service";
import { evaluateAccessFresh } from "@/lib/entitlement-access/service";
import { evaluateAccessForLauncher, clearLauncherAccessCache } from "@/lib/entitlement-access/launcher-cache";

const APP_ID = "app-en003-en002";
let parentId: string;
let learnerId: string;
let subscriptionId: string;

beforeEach(async () => {
  useInMemoryDb();
  clearLauncherAccessCache();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,
    owning_team,registry_status) values(?,?,'Math App','Math','icon-abacus','learning','team','active')`)
    .run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("en003-en002-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = (await createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "90000000-0000-4000-8000-000000000001" }, "2026-08-10")).learner.id;
  const productId = (await defineProductVersion({ id: "product-en003-en002", slug: "en003-en002-monthly",
    name: "Math Monthly", subdomain: "en003en002.example.test", planReference: "plan-en003en002", priceInr: 299,
    productType: "individual_app", version: 1, appIds: [APP_ID] })).id;
  subscriptionId = `sub-${randomUUID()}`;
  getDb().prepare(
    `insert into subscriptions(id,user_id,type,product_id,purchaser_parent_id,assigned_learner_id,product_version,
     razorpay_subscription_id,current_period_end) values(?,?,?,?,?,?,?,?,?)`,
  ).run(subscriptionId, parentId, "single", productId, parentId, learnerId, 1,
    `razorpay-${subscriptionId}`, "2026-09-01T00:00:00.000Z");
  await applyPaidCycle({
    paidCycleId: `cycle-${randomUUID()}`, eventId: `event-${randomUUID()}`, eventVersion: 1,
    subscriptionId, purchaserParentId: parentId, assignedLearnerId: learnerId,
    productId: "product-1", productVersion: 1, appIds: [APP_ID],
    periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z",
    billingAnchor: "2026-08-01", environment: "production", now: new Date("2026-08-01T00:00:00.000Z"),
  });
});

describe("EN-003 x EN-002: launcher cache invalidation (rule 5/6)", () => {
  it("invalidates a cached launcher decision the moment a terminal transition applies", async () => {
    const now = new Date("2026-08-15T10:00:00.000Z");
    const before = await evaluateAccessForLauncher({ learnerId, appId: APP_ID, environment: "production", now });
    expect(before.allowed).toBe(true);

    await applyLifecycleEvent({
      eventId: "cache-invalidate-1", eventType: "security_revoked", source: "platform_security",
      sourceVersion: 1, effectiveAt: now.toISOString(),
      sourceReference: { learnerId, appId: APP_ID, reasonCategory: "security_admin_action" },
      now,
    });

    const after = await evaluateAccessForLauncher({ learnerId, appId: APP_ID, environment: "production",
      now: new Date(now.getTime() + 1000) });
    expect(after).toMatchObject({ allowed: false, state: "suspended_security" });
  });
});

describe("EN-003 rules 47-48: reconcile-lifecycle chargeback reversal restoration", () => {
  it("restores access only via exact reconciliation, never the webhook alone", async () => {
    const now = new Date("2026-08-15T10:00:00.000Z");
    await applyLifecycleEvent({
      eventId: "chargeback-for-reversal-1", eventType: "chargeback_confirmed", source: "billing_chargeback",
      sourceVersion: 1, effectiveAt: now.toISOString(),
      sourceReference: { subscriptionId, learnerId, reasonCategory: "payment_reversal" },
      now,
    });
    expect((await evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "production", useCase: "start",
      now: new Date(now.getTime() + 1000) })).allowed).toBe(false);

    const reversedAt = new Date("2026-08-20T10:00:00.000Z");
    getDb().prepare(
      `insert into financial_dispute_events(id,provider,provider_event_id,event_type,subscription_id,
       fraud_or_security_risk,occurred_at,payload_hash,status,created_at)
       values(?,'test-provider','reversal-event-1','chargeback_reversed',?,0,?,'hash','received',?)`,
    ).run(randomUUID(), subscriptionId, reversedAt.toISOString(), reversedAt.toISOString());

    const result = await reconcileEntitlementLifecycle("reconciler-1",
      { subscriptionId, runIdempotencyKey: "reconcile-restore-1" }, reversedAt);
    expect(result).toMatchObject({ scanned: 1, restored: 1, skipped: 0, errors: 0 });

    const access = await evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "production", useCase: "start",
      now: new Date(reversedAt.getTime() + 1000) });
    expect(access.allowed).toBe(true);

    const dispute = getDb().prepare("select status from financial_dispute_events where provider_event_id='reversal-event-1'")
      .get() as any;
    expect(dispute.status).toBe("processed");
  });

  it("does not restore once the original paid period has ended (rule 47)", async () => {
    const now = new Date("2026-08-15T10:00:00.000Z");
    await applyLifecycleEvent({
      eventId: "chargeback-for-reversal-2", eventType: "chargeback_confirmed", source: "billing_chargeback",
      sourceVersion: 1, effectiveAt: now.toISOString(),
      sourceReference: { subscriptionId, learnerId, reasonCategory: "payment_reversal" },
      now,
    });
    const reversedAt = new Date("2026-10-01T10:00:00.000Z");
    getDb().prepare(
      `insert into financial_dispute_events(id,provider,provider_event_id,event_type,subscription_id,
       fraud_or_security_risk,occurred_at,payload_hash,status,created_at)
       values(?,'test-provider','reversal-event-2','chargeback_reversed',?,0,?,'hash','received',?)`,
    ).run(randomUUID(), subscriptionId, reversedAt.toISOString(), reversedAt.toISOString());

    const result = await reconcileEntitlementLifecycle("reconciler-2",
      { subscriptionId, runIdempotencyKey: "reconcile-restore-2" }, reversedAt);
    expect(result).toMatchObject({ scanned: 1, restored: 0, skipped: 1, errors: 0 });
    expect((await evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "production", useCase: "start",
      now: new Date(reversedAt.getTime() + 1000) })).allowed).toBe(false);
  });
});
