import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { processVerifiedPaymentEvent } from "@/lib/billing/bi002-service";
import { runGraceExpirySweep } from "@/lib/billing/bi003-service";
import { cancelSubscriptionAtPeriodEnd, resumeSubscriptionAutoRenewal } from "@/lib/billing/bi004-service";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter, VerifiedProviderPaymentEvent } from "@/lib/billing/provider-adapter";

const APP_ID = "app-en003-wiring";
const ACCOUNT_ID = "acct-en003-wiring";
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

async function checkout(key: string) {
  const view = await getProductPurchaseView(productId);
  return await createCheckoutIntent(parentId, { learnerId, productId, productVersion: view.version,
    priceId: view.price.id, priceVersion: view.price.version, autoRenewEnabled: true,
    consentDisclosureVersion: BILLING_CONSENT_DISCLOSURE_VERSION, idempotencyKey: key },
  { now: new Date("2026-08-10T09:59:00.000Z"), provider });
}

async function activate(key: string) {
  const created = await checkout(key);
  const intent = getDb().prepare("select * from checkout_intents where id=?").get(created.checkoutIntentId) as any;
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(intent.subscription_id) as any;
  const result = await processVerifiedPaymentEvent({ provider: intent.provider, environment: intent.provider_environment,
    accountId: intent.provider_account_id, providerEventId: `activation:${key}`,
    eventType: "initial_payment_succeeded", checkoutIntentId: intent.id,
    providerCheckoutRef: intent.provider_checkout_ref, providerPaymentRef: `initial-payment:${key}`,
    providerSubscriptionRef: subscription.provider_subscription_ref, providerMandateRef: intent.provider_mandate_ref,
    amount: intent.amount, currency: intent.currency, priceId: intent.price_id, priceVersion: intent.price_version,
    settledAt: "2026-08-10T10:00:00.000Z" }, new Date("2026-08-10T10:01:00.000Z")) as any;
  return result.subscriptionId as string;
}

function renewalEvent(subscriptionId: string, suffix: string, eventType: VerifiedProviderPaymentEvent["eventType"],
  settledAt: string): VerifiedProviderPaymentEvent {
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(subscriptionId) as any;
  const price = getDb().prepare("select * from product_prices where id=?").get(subscription.billing_price_id) as any;
  return { provider: subscription.provider, environment: subscription.provider_environment,
    accountId: subscription.provider_account_id, providerEventId: `renewal:${suffix}`, eventType, subscriptionId,
    providerPaymentRef: `renewal-payment:${suffix}`, providerSubscriptionRef: subscription.provider_subscription_ref,
    amount: price.unit_amount, currency: price.currency, priceId: price.id, priceVersion: price.version,
    attemptedAt: settledAt, settledAt };
}

function lifecycleEventTypes(subscriptionId: string): string[] {
  return (getDb().prepare(
    "select event_type from entitlement_lifecycle_events where subscription_id=? order by created_at",
  ).all(subscriptionId) as { event_type: string }[]).map((row) => row.event_type);
}

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,
    owning_team,registry_status) values(?,?,'Math App','Math','icon-abacus','learning','team','active')`)
    .run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("en003-wiring-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = (await createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "a0000000-0000-4000-8000-000000000001" }, "2026-08-10")).learner.id;
  productId = (await defineProductVersion({ id: "product-en003-wiring", slug: "en003-wiring-monthly",
    name: "Math Monthly", subdomain: "en003wiring.example.test", planReference: "plan-en003wiring",
    priceInr: 299, productType: "individual_app", version: 1, appIds: [APP_ID] })).id;
});

describe("EN-003 audit-ledger wiring for BI-002/BI-003/BI-004's own lazy transitions", () => {
  it("records grace_started, then grace_recovered on a successful recovery renewal", async () => {
    const subscriptionId = await activate("grace-recover");
    const subscription = getDb().prepare("select current_period_end from subscriptions where id=?")
      .get(subscriptionId) as any;
    await processVerifiedPaymentEvent(renewalEvent(subscriptionId, "fail-1", "renewal_failed",
      subscription.current_period_end), new Date(subscription.current_period_end));
    expect(lifecycleEventTypes(subscriptionId)).toEqual(["grace_started"]);

    const graceRow = getDb().prepare("select grace_ends_at from subscriptions where id=?").get(subscriptionId) as any;
    const recoveredAt = new Date(new Date(graceRow.grace_ends_at).getTime() - 3600_000).toISOString();
    await processVerifiedPaymentEvent(renewalEvent(subscriptionId, "recover-1", "payment_recovered", recoveredAt),
      new Date(recoveredAt));
    expect(lifecycleEventTypes(subscriptionId)).toEqual(["grace_started", "grace_recovered"]);
  });

  it("records grace_expired when the sweep lapses an unrecovered grace window", async () => {
    const subscriptionId = await activate("grace-expire");
    const subscription = getDb().prepare("select current_period_end from subscriptions where id=?")
      .get(subscriptionId) as any;
    await processVerifiedPaymentEvent(renewalEvent(subscriptionId, "fail-2", "renewal_failed",
      subscription.current_period_end), new Date(subscription.current_period_end));
    const graceRow = getDb().prepare("select grace_ends_at from subscriptions where id=?").get(subscriptionId) as any;
    await runGraceExpirySweep("test-principal", { limit: 10, runIdempotencyKey: "expiry-sweep-1" },
      { now: new Date(new Date(graceRow.grace_ends_at).getTime() + 1000) });
    expect(lifecycleEventTypes(subscriptionId)).toEqual(["grace_started", "grace_expired"]);
  });

  it("records cancellation_effective when the cancellation boundary lapses, and cancellation_reversed on resume", async () => {
    const subscriptionId = await activate("cancel-reverse");
    const subscription = getDb().prepare("select * from subscriptions where id=?").get(subscriptionId) as any;
    await cancelSubscriptionAtPeriodEnd(parentId, subscriptionId,
      { expectedVersion: subscription.version, idempotencyKey: "cancel-1" },
      { now: new Date("2026-08-15T10:00:00.000Z"), adapter: provider });
    expect(lifecycleEventTypes(subscriptionId)).toEqual([]);

    await resumeSubscriptionAutoRenewal(parentId, subscriptionId,
      { expectedVersion: subscription.version + 1, idempotencyKey: "resume-1" },
      { now: new Date("2026-08-20T10:00:00.000Z"), adapter: provider });
    expect(lifecycleEventTypes(subscriptionId)).toEqual(["cancellation_reversed"]);
  });

  it("records cancellation_effective once the boundary actually lapses without reversal", async () => {
    const subscriptionId = await activate("cancel-lapse");
    const subscription = getDb().prepare("select * from subscriptions where id=?").get(subscriptionId) as any;
    await cancelSubscriptionAtPeriodEnd(parentId, subscriptionId,
      { expectedVersion: subscription.version, idempotencyKey: "cancel-2" },
      { now: new Date("2026-08-15T10:00:00.000Z"), adapter: provider });
    const after = getDb().prepare("select current_period_end from subscriptions where id=?").get(subscriptionId) as any;
    // Resuming after the boundary lapses forces the lazy expiry check inside
    // resumeSubscriptionAutoRenewal, which is what actually records the event.
    await expect(resumeSubscriptionAutoRenewal(parentId, subscriptionId,
      { expectedVersion: subscription.version + 1, idempotencyKey: "resume-2" },
      { now: new Date(new Date(after.current_period_end).getTime() + 1000), adapter: provider })).rejects.toThrow();
    expect(lifecycleEventTypes(subscriptionId)).toEqual(["cancellation_effective"]);
  });
});
