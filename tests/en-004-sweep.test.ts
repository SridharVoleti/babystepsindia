import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { processVerifiedPaymentEvent } from "@/lib/billing/bi002-service";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter } from "@/lib/billing/provider-adapter";
import { runEntitlementIntegritySweep } from "@/lib/entitlement-integrity/sweep";

const APP_ID = "app-en004-sweep";
const ACCOUNT_ID = "acct-en004-sweep";
let parentId: string;
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

async function activateFor(key: string) {
  const learnerId = (await createLearner(parentId, { displayName: `Learner-${key}`, dateOfBirth: "2018-02-10",
    idempotencyKey: `idemp-${key}` }, "2026-08-10")).learner.id;
  const view = await getProductPurchaseView(productId);
  const created = await createCheckoutIntent(parentId, { learnerId, productId, productVersion: view.version,
    priceId: view.price.id, priceVersion: view.price.version, autoRenewEnabled: true,
    consentDisclosureVersion: BILLING_CONSENT_DISCLOSURE_VERSION, idempotencyKey: key },
  { now: new Date("2026-08-10T09:59:00.000Z"), provider });
  const intent = getDb().prepare("select * from checkout_intents where id=?").get(created.checkoutIntentId) as any;
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(intent.subscription_id) as any;
  const result = await processVerifiedPaymentEvent({ provider: intent.provider, environment: intent.provider_environment,
    accountId: intent.provider_account_id, providerEventId: `activation:${key}`,
    eventType: "initial_payment_succeeded", checkoutIntentId: intent.id,
    providerCheckoutRef: intent.provider_checkout_ref, providerPaymentRef: `initial-payment:${key}`,
    providerSubscriptionRef: subscription.provider_subscription_ref, providerMandateRef: intent.provider_mandate_ref,
    amount: intent.amount, currency: intent.currency, priceId: intent.price_id, priceVersion: intent.price_version,
    settledAt: "2026-08-10T10:00:00.000Z" }, new Date("2026-08-10T10:01:00.000Z")) as any;
  return { learnerId, subscriptionId: result.subscriptionId as string, billingPeriodId: result.billingPeriodId as string };
}

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,
    owning_team,registry_status) values(?,?,'Math App','Math','icon-abacus','learning','team','active')`)
    .run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("en004-sweep-parent@example.com", "CorrectHorse1!")).user.id;
  productId = (await defineProductVersion({ id: "product-en004-sweep", slug: "en004-sweep-monthly",
    name: "Math Monthly", subdomain: "en004sweep.example.test", planReference: "plan-en004sweep",
    priceInr: 299, productType: "individual_app", version: 1, appIds: [APP_ID] })).id;
});

describe("runEntitlementIntegritySweep", () => {
  it("processes a healthy, a repairable, an orphan and a conflicting row in one bounded pass", async () => {
    const healthy = await activateFor("sweep-healthy");
    const missing = await activateFor("sweep-missing");
    const orphan = await activateFor("sweep-orphan");
    const conflict = await activateFor("sweep-conflict");

    getDb().prepare("update learner_app_entitlement_periods set standard_credit_batch_id=null,effective_entitlement_id=null where learner_id=?").run(missing.learnerId);
    getDb().prepare("delete from learner_app_effective_sources where effective_entitlement_id in " +
      "(select id from learner_app_effective_entitlements where learner_id=?)").run(missing.learnerId);
    getDb().prepare("delete from learner_app_effective_entitlements where learner_id=?").run(missing.learnerId);
    getDb().prepare("delete from learner_app_standard_credit_batches where learner_id=?").run(missing.learnerId);
    getDb().prepare("delete from learner_app_entitlement_periods where learner_id=?").run(missing.learnerId);
    getDb().prepare("delete from entitlement_cycles where paid_cycle_id=?").run(missing.billingPeriodId);
    getDb().prepare("delete from entitlement_application_receipts where paid_cycle_id=?").run(missing.billingPeriodId);

    getDb().prepare("update billing_periods set status='failed' where id=?").run(orphan.billingPeriodId);
    getDb().prepare("update entitlement_cycles set product_version=2 where paid_cycle_id=?").run(conflict.billingPeriodId);

    const result = await runEntitlementIntegritySweep("integrity-monitor",
      { environment: "test", limit: 50, runIdempotencyKey: "sweep-run-1" }, new Date("2026-08-25T00:00:00.000Z"));

    expect(result.processed).toBe(4);
    expect(result.healthyCount).toBe(1);
    expect(result.repairedCount).toBe(1);
    expect(result.deferredCount).toBe(1);
    // conflict row's incident (primary pass) + orphan's incident (second pass) = 2
    expect(result.incidentsOpenedCount).toBe(2);
    expect(result.nextCursor).toBeNull();

    const orphanIncident = getDb().prepare("select category from entitlement_integrity_incidents where source_id=?")
      .get(orphan.billingPeriodId) as any;
    expect(orphanIncident.category).toBe("ENTITLEMENT_WITHOUT_VERIFIED_SOURCE");
    const conflictIncident = getDb().prepare("select category from entitlement_integrity_incidents where source_id=?")
      .get(conflict.billingPeriodId) as any;
    expect(conflictIncident.category).toBe("PRODUCT_SNAPSHOT_MISMATCH");
  });

  it("is bounded and paginates via an id cursor", async () => {
    await activateFor("page-a");
    await activateFor("page-b");
    await activateFor("page-c");

    const firstPage = await runEntitlementIntegritySweep("integrity-monitor",
      { environment: "test", limit: 2, runIdempotencyKey: "sweep-page-1" }, new Date("2026-08-25T00:00:00.000Z"));
    expect(firstPage.processed).toBe(2);
    expect(firstPage.nextCursor).toBeTruthy();

    const secondPage = await runEntitlementIntegritySweep("integrity-monitor",
      { environment: "test", cursor: firstPage.nextCursor!, limit: 2, runIdempotencyKey: "sweep-page-2" },
      new Date("2026-08-25T00:00:01.000Z"));
    expect(secondPage.processed).toBe(1);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("rule 55: a duplicate run with the same idempotency key and cursor returns the cached page, not a reprocessed one", async () => {
    await activateFor("dup-a");
    const first = await runEntitlementIntegritySweep("integrity-monitor",
      { environment: "test", limit: 50, runIdempotencyKey: "sweep-dup-1" }, new Date("2026-08-25T00:00:00.000Z"));
    const second = await runEntitlementIntegritySweep("integrity-monitor",
      { environment: "test", limit: 50, runIdempotencyKey: "sweep-dup-1" }, new Date("2026-08-25T00:05:00.000Z"));
    expect(second).toEqual(first);
  });

  it("rule 7: environment isolation — a production sweep never touches a test-environment gap", async () => {
    const testRow = await activateFor("env-test");
    getDb().prepare("update learner_app_entitlement_periods set standard_credit_batch_id=null,effective_entitlement_id=null where learner_id=?").run(testRow.learnerId);
    getDb().prepare("delete from learner_app_effective_sources where effective_entitlement_id in " +
      "(select id from learner_app_effective_entitlements where learner_id=?)").run(testRow.learnerId);
    getDb().prepare("delete from learner_app_effective_entitlements where learner_id=?").run(testRow.learnerId);
    getDb().prepare("delete from learner_app_standard_credit_batches where learner_id=?").run(testRow.learnerId);
    getDb().prepare("delete from learner_app_entitlement_periods where learner_id=?").run(testRow.learnerId);
    getDb().prepare("delete from entitlement_cycles where paid_cycle_id=?").run(testRow.billingPeriodId);

    const result = await runEntitlementIntegritySweep("integrity-monitor",
      { environment: "production", limit: 50, runIdempotencyKey: "sweep-env-1" }, new Date("2026-08-25T00:00:00.000Z"));

    expect(result.processed).toBe(0);
    const cycle = getDb().prepare("select id from entitlement_cycles where paid_cycle_id=?").get(testRow.billingPeriodId);
    expect(cycle).toBeUndefined();
  });
});
