import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { processVerifiedPaymentEvent } from "@/lib/billing/bi002-service";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter } from "@/lib/billing/provider-adapter";
import { EntitlementIntegrityError } from "@/lib/entitlement-integrity/errors";
import { reconcilePaidCycle, reconcileLearnerApp } from "@/lib/entitlement-integrity/repair";

const APP_ID = "app-en004-repair";
const ACCOUNT_ID = "acct-en004-repair";
let parentId: string;
let learnerId: string;
let productId: string;

const provider: BillingCheckoutProviderAdapter = {
  createCheckout(input) { return { provider: "contract-provider", environment: "test", accountId: ACCOUNT_ID,
    providerCheckoutRef: `checkout:${input.checkoutIntentId}`,
    providerSubscriptionRef: `provider-sub:${input.checkoutIntentId}`,
    providerMandateRef: `mandate:${input.checkoutIntentId}`,
    handoff: { url: `/provider/${input.checkoutIntentId}`, method: "GET" } }; },
  disableAutoRenewal: vi.fn(() => ({ confirmed: true as const })),
  getRecurringAgreementStatus() { return { status: "valid" as const }; },
  enableAutoRenewal: vi.fn(() => ({ confirmed: true as const })),
  stopRenewalRetries() { return { confirmed: true }; },
  listReconciliationEvents() { return { events: [], nextCursor: null }; },
};

function checkout(key: string) {
  const view = getProductPurchaseView(productId);
  return createCheckoutIntent(parentId, { learnerId, productId, productVersion: view.version,
    priceId: view.price.id, priceVersion: view.price.version, autoRenewEnabled: true,
    consentDisclosureVersion: BILLING_CONSENT_DISCLOSURE_VERSION, idempotencyKey: key },
  { now: new Date("2026-08-10T09:59:00.000Z"), provider });
}

function activate(key: string) {
  const created = checkout(key);
  const intent = getDb().prepare("select * from checkout_intents where id=?").get(created.checkoutIntentId) as any;
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(intent.subscription_id) as any;
  const result = processVerifiedPaymentEvent({ provider: intent.provider, environment: intent.provider_environment,
    accountId: intent.provider_account_id, providerEventId: `activation:${key}`,
    eventType: "initial_payment_succeeded", checkoutIntentId: intent.id,
    providerCheckoutRef: intent.provider_checkout_ref, providerPaymentRef: `initial-payment:${key}`,
    providerSubscriptionRef: subscription.provider_subscription_ref, providerMandateRef: intent.provider_mandate_ref,
    amount: intent.amount, currency: intent.currency, priceId: intent.price_id, priceVersion: intent.price_version,
    settledAt: "2026-08-10T10:00:00.000Z" }, new Date("2026-08-10T10:01:00.000Z")) as any;
  return { subscriptionId: result.subscriptionId as string, billingPeriodId: result.billingPeriodId as string };
}

function subscriptionVersion(subscriptionId: string): number {
  return (getDb().prepare("select version from subscriptions where id=?").get(subscriptionId) as { version: number }).version;
}

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,
    owning_team,registry_status) values(?,?,'Math App','Math','icon-abacus','learning','team','active')`)
    .run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("en004-repair-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = (await createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "a0000000-0000-4000-8000-000000000002" }, "2026-08-10")).learner.id;
  productId = defineProductVersion({ id: "product-en004-repair", slug: "en004-repair-monthly",
    name: "Math Monthly", subdomain: "en004repair.example.test", planReference: "plan-en004repair",
    priceInr: 299, productType: "individual_app", version: 1, appIds: [APP_ID] }).id;
});

describe("reconcilePaidCycle", () => {
  it("rule 10: repairs a fully missing entitlement_cycle for a verified paid cycle", async () => {
    const { subscriptionId, billingPeriodId } = activate("missing-entitlement");
    getDb().prepare("update learner_app_entitlement_periods set standard_credit_batch_id=null,effective_entitlement_id=null where learner_id=?").run(learnerId);
    getDb().prepare("delete from learner_app_effective_sources where effective_entitlement_id in " +
      "(select id from learner_app_effective_entitlements where learner_id=?)").run(learnerId);
    getDb().prepare("delete from learner_app_effective_entitlements where learner_id=?").run(learnerId);
    getDb().prepare("delete from learner_app_standard_credit_batches where learner_id=?").run(learnerId);
    getDb().prepare("delete from learner_app_entitlement_periods where learner_id=?").run(learnerId);
    getDb().prepare("delete from entitlement_cycles where paid_cycle_id=?").run(billingPeriodId);
    getDb().prepare("delete from entitlement_application_receipts where paid_cycle_id=?").run(billingPeriodId);

    const result = await reconcilePaidCycle({ paidCycleId: billingPeriodId, expectedSourceVersion: subscriptionVersion(subscriptionId),
      principalId: "integrity-monitor", runIdempotencyKey: "recon-1", now: new Date("2026-08-20T00:00:00.000Z") });

    expect(result.action).toBe("repair");
    expect(result.category).toBe("MISSING_ENTITLEMENT");
    const cycle = getDb().prepare("select status from entitlement_cycles where paid_cycle_id=?").get(billingPeriodId) as any;
    expect(cycle.status).toBe("ready");
    const period = getDb().prepare("select effective_source_role,standard_credit_batch_id from learner_app_entitlement_periods where learner_id=? and app_id=?")
      .get(learnerId, APP_ID) as any;
    expect(period.effective_source_role).toBe("allocation_bearing");
    expect(period.standard_credit_batch_id).toBeTruthy();
    const batch = getDb().prepare("select granted_count,reserved_count,consumed_count from learner_app_standard_credit_batches where id=?")
      .get(period.standard_credit_batch_id) as any;
    expect(batch).toEqual({ granted_count: 8, reserved_count: 0, consumed_count: 0 });
  });

  it("rule 11: retries an incomplete (failed) entitlement_cycle using the original source event and dates", async () => {
    const { subscriptionId, billingPeriodId } = activate("incomplete-entitlement");
    const originalPeriod = getDb().prepare("select period_start,period_end from learner_app_entitlement_periods where learner_id=? and app_id=?")
      .get(learnerId, APP_ID) as any;
    getDb().prepare("update entitlement_cycles set status='failed' where paid_cycle_id=?").run(billingPeriodId);

    const result = await reconcilePaidCycle({ paidCycleId: billingPeriodId, expectedSourceVersion: subscriptionVersion(subscriptionId),
      principalId: "integrity-monitor", runIdempotencyKey: "recon-2", now: new Date("2026-08-20T00:00:00.000Z") });

    expect(result.action).toBe("repair");
    expect(result.category).toBe("INCOMPLETE_ENTITLEMENT");
    const cycle = getDb().prepare("select status from entitlement_cycles where paid_cycle_id=?").get(billingPeriodId) as any;
    expect(cycle.status).toBe("ready");
    const repairedPeriod = getDb().prepare("select period_start,period_end from learner_app_entitlement_periods where learner_id=? and app_id=?")
      .get(learnerId, APP_ID) as any;
    expect(repairedPeriod).toEqual(originalPeriod);
  });

  it("rule 21/22: a product-version mismatch is quarantined as a conflict, never silently rewritten", async () => {
    const { subscriptionId, billingPeriodId } = activate("product-mismatch");
    getDb().prepare("update entitlement_cycles set product_version=2 where paid_cycle_id=?").run(billingPeriodId);

    await expect(reconcilePaidCycle({ paidCycleId: billingPeriodId, expectedSourceVersion: subscriptionVersion(subscriptionId),
      principalId: "integrity-monitor", runIdempotencyKey: "recon-3", now: new Date("2026-08-20T00:00:00.000Z") }))
      .rejects.toThrow(EntitlementIntegrityError);

    const cycle = getDb().prepare("select product_version from entitlement_cycles where paid_cycle_id=?").get(billingPeriodId) as any;
    expect(cycle.product_version).toBe(2); // untouched, not silently rewritten back to 1
    const incident = getDb().prepare("select category,status from entitlement_integrity_incidents where source_id=?")
      .get(billingPeriodId) as any;
    expect(incident).toEqual({ category: "PRODUCT_SNAPSHOT_MISMATCH", status: "open" });
  });

  it("rules 18-20: reconciling an already-healthy cycle a second time never duplicates or resets the batch", async () => {
    const { subscriptionId, billingPeriodId } = activate("healthy-noop");
    const period = getDb().prepare("select standard_credit_batch_id from learner_app_entitlement_periods where learner_id=? and app_id=?")
      .get(learnerId, APP_ID) as any;
    getDb().prepare("update learner_app_standard_credit_batches set reserved_count=2,consumed_count=1 where id=?")
      .run(period.standard_credit_batch_id);

    const result = await reconcilePaidCycle({ paidCycleId: billingPeriodId, expectedSourceVersion: subscriptionVersion(subscriptionId),
      principalId: "integrity-monitor", runIdempotencyKey: "recon-4", now: new Date("2026-08-20T00:00:00.000Z") });

    expect(result.action).toBe("healthy");
    const batchCount = (getDb().prepare("select count(*) as n from learner_app_standard_credit_batches where learner_id=?")
      .get(learnerId) as any).n;
    expect(batchCount).toBe(1);
    const batch = getDb().prepare("select reserved_count,consumed_count from learner_app_standard_credit_batches where id=?")
      .get(period.standard_credit_batch_id) as any;
    expect(batch).toEqual({ reserved_count: 2, consumed_count: 1 });
  });

  it("rules 34-35: an otherwise-healthy cycle missing its allocation batch gets one created", async () => {
    const { subscriptionId, billingPeriodId } = activate("missing-batch");
    const period = getDb().prepare("select id,standard_credit_batch_id from learner_app_entitlement_periods where learner_id=? and app_id=?")
      .get(learnerId, APP_ID) as any;
    getDb().prepare("update learner_app_entitlement_periods set standard_credit_batch_id=null where id=?").run(period.id);
    getDb().prepare("delete from learner_app_standard_credit_batches where id=?").run(period.standard_credit_batch_id);

    const result = await reconcilePaidCycle({ paidCycleId: billingPeriodId, expectedSourceVersion: subscriptionVersion(subscriptionId),
      principalId: "integrity-monitor", runIdempotencyKey: "recon-5", now: new Date("2026-08-20T00:00:00.000Z") });

    expect(result.action).toBe("repair");
    const repairedPeriod = getDb().prepare("select standard_credit_batch_id from learner_app_entitlement_periods where id=?")
      .get(period.id) as any;
    expect(repairedPeriod.standard_credit_batch_id).toBeTruthy();
    const batch = getDb().prepare("select granted_count from learner_app_standard_credit_batches where id=?")
      .get(repairedPeriod.standard_credit_batch_id) as any;
    expect(batch.granted_count).toBe(8);
  });

  it("rule 6/55: reconciling the same missing gap twice is idempotent — no duplicate cycle", async () => {
    const { subscriptionId, billingPeriodId } = activate("idempotent-repeat");
    getDb().prepare("update learner_app_entitlement_periods set standard_credit_batch_id=null,effective_entitlement_id=null where learner_id=?").run(learnerId);
    getDb().prepare("delete from learner_app_effective_sources where effective_entitlement_id in " +
      "(select id from learner_app_effective_entitlements where learner_id=?)").run(learnerId);
    getDb().prepare("delete from learner_app_effective_entitlements where learner_id=?").run(learnerId);
    getDb().prepare("delete from learner_app_standard_credit_batches where learner_id=?").run(learnerId);
    getDb().prepare("delete from learner_app_entitlement_periods where learner_id=?").run(learnerId);
    getDb().prepare("delete from entitlement_cycles where paid_cycle_id=?").run(billingPeriodId);
    getDb().prepare("delete from entitlement_application_receipts where paid_cycle_id=?").run(billingPeriodId);

    const first = await reconcilePaidCycle({ paidCycleId: billingPeriodId, expectedSourceVersion: subscriptionVersion(subscriptionId),
      principalId: "integrity-monitor", runIdempotencyKey: "recon-6a", now: new Date("2026-08-20T00:00:00.000Z") });
    const second = await reconcilePaidCycle({ paidCycleId: billingPeriodId, expectedSourceVersion: subscriptionVersion(subscriptionId),
      principalId: "integrity-monitor", runIdempotencyKey: "recon-6b", now: new Date("2026-08-20T00:00:01.000Z") });

    expect(first.action).toBe("repair");
    expect(second.action).toBe("healthy");
    const cycleCount = (getDb().prepare("select count(*) as n from entitlement_cycles where paid_cycle_id=?")
      .get(billingPeriodId) as any).n;
    expect(cycleCount).toBe(1);
  });

  it("rule 59: a not-yet-verified billing period is skipped, not repaired", async () => {
    const { subscriptionId, billingPeriodId } = activate("unverified-skip");
    getDb().prepare("update billing_periods set status='failed' where id=?").run(billingPeriodId);

    const result = await reconcilePaidCycle({ paidCycleId: billingPeriodId, expectedSourceVersion: subscriptionVersion(subscriptionId),
      principalId: "integrity-monitor", runIdempotencyKey: "recon-7", now: new Date("2026-08-20T00:00:00.000Z") });
    expect(result).toEqual({ paidCycleId: billingPeriodId, action: "defer", category: null, entitlementCycleId: null });
  });

  it("rejects a stale expectedSourceVersion", async () => {
    const { subscriptionId, billingPeriodId } = activate("stale-version");
    await expect(reconcilePaidCycle({ paidCycleId: billingPeriodId, expectedSourceVersion: subscriptionVersion(subscriptionId) + 1,
      principalId: "integrity-monitor", runIdempotencyKey: "recon-8", now: new Date("2026-08-20T00:00:00.000Z") }))
      .rejects.toThrow(EntitlementIntegrityError);
  });
});

describe("reconcileLearnerApp", () => {
  it("rule 27: replays a stuck pending lifecycle event affecting this app", async () => {
    const { } = activate("pending-lifecycle");
    const effective = getDb().prepare("select id,effective_version from learner_app_effective_entitlements where learner_id=? and app_id=?")
      .get(learnerId, APP_ID) as any;

    const eventRowId = randomUUID();
    const nowIso = "2026-08-21T00:00:00.000Z";
    getDb().prepare(`insert into entitlement_lifecycle_events(id,source,event_id,event_type,source_version,effective_at,
      learner_id,app_ids_json,environment,reason_category,fraud_or_security_risk,payload_hash,status,received_at,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?,?)`)
      .run(eventRowId, "platform_security", randomUUID(), "security_revoked", 1, nowIso, learnerId,
        JSON.stringify([APP_ID]), null, "manual_admin_action", 1, "placeholder-hash", nowIso, nowIso, nowIso);

    const result = await reconcileLearnerApp({ learnerId, appId: APP_ID, environment: "test",
      expectedSourceVersion: effective.effective_version, principalId: "integrity-monitor",
      runIdempotencyKey: "recon-la-1", now: new Date("2026-08-21T00:00:01.000Z") });

    expect(result.action).toBe("repair");
    expect(result.replayedEventIds).toEqual([eventRowId]);
    const eventRow = getDb().prepare("select status from entitlement_lifecycle_events where id=?").get(eventRowId) as any;
    expect(eventRow.status).toBe("applied");
    const updated = getDb().prepare("select state,integrity_state from learner_app_effective_entitlements where id=?")
      .get(effective.id) as any;
    expect(updated.state).toBe("suspended_security");
    expect(updated.integrity_state).toBe("healthy");
  });

  it("is a healthy no-op when nothing is pending", async () => {
    activate("no-pending");
    const effective = getDb().prepare("select id,effective_version from learner_app_effective_entitlements where learner_id=? and app_id=?")
      .get(learnerId, APP_ID) as any;

    const result = await reconcileLearnerApp({ learnerId, appId: APP_ID, environment: "test",
      expectedSourceVersion: effective.effective_version, principalId: "integrity-monitor",
      runIdempotencyKey: "recon-la-2", now: new Date("2026-08-21T00:00:00.000Z") });

    expect(result.action).toBe("healthy");
    expect(result.replayedEventIds).toEqual([]);
  });

  it("rejects a stale expectedSourceVersion", async () => {
    activate("stale-effective-version");
    const effective = getDb().prepare("select effective_version from learner_app_effective_entitlements where learner_id=? and app_id=?")
      .get(learnerId, APP_ID) as any;
    await expect(reconcileLearnerApp({ learnerId, appId: APP_ID, environment: "test",
      expectedSourceVersion: effective.effective_version + 1, principalId: "integrity-monitor",
      runIdempotencyKey: "recon-la-3", now: new Date("2026-08-21T00:00:00.000Z") }))
      .rejects.toThrow(EntitlementIntegrityError);
  });
});
