// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { processVerifiedPaymentEvent } from "@/lib/billing/bi002-service";
import { runGraceExpirySweep } from "@/lib/billing/bi003-service";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter, VerifiedProviderPaymentEvent } from "@/lib/billing/provider-adapter";

const APP_ID = "app-nt001-bi003-math";
const ACCOUNT_ID = "acct-nt001-bi003";
const ACTIVATED_AT = "2026-08-10T10:00:00.000Z";
let parentId: string;
let learnerId: string;
let productId: string;

const stopRenewalRetries = vi.fn(() => ({ confirmed: true as const }));
const provider: BillingCheckoutProviderAdapter = {
  createCheckout(input) { return { provider: "contract-provider", environment: "test", accountId: ACCOUNT_ID,
    providerCheckoutRef: `checkout:${input.checkoutIntentId}`,
    providerSubscriptionRef: `provider-sub:${input.checkoutIntentId}`,
    providerMandateRef: `mandate:${input.checkoutIntentId}`,
    handoff: { url: `/provider/${input.checkoutIntentId}`, method: "GET" } }; },
  disableAutoRenewal() { return { confirmed: true }; },
  createPaymentMethodUpdateSession(input) { return { providerSessionRef: `update:${input.idempotencyKey}`,
    handoffUrl: `/provider/update/${input.subscriptionId}`, expiresAt: input.expiresAt }; },
  stopRenewalRetries,
  listReconciliationEvents() { return { events: [], nextCursor: null }; },
};

function checkout(key = "checkout") {
  const view = getProductPurchaseView(productId);
  return createCheckoutIntent(parentId, { learnerId, productId, productVersion: view.version,
    priceId: view.price.id, priceVersion: view.price.version, autoRenewEnabled: true,
    consentDisclosureVersion: BILLING_CONSENT_DISCLOSURE_VERSION, idempotencyKey: key },
  { now: new Date("2026-08-10T09:59:00.000Z"), provider });
}

function activate(key = "checkout") {
  const created = checkout(key);
  const intent = getDb().prepare("select * from checkout_intents where id=?").get(created.checkoutIntentId) as any;
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(intent.subscription_id) as any;
  const result = processVerifiedPaymentEvent({ provider: intent.provider, environment: intent.provider_environment,
    accountId: intent.provider_account_id, providerEventId: `activation:${key}`,
    eventType: "initial_payment_succeeded", checkoutIntentId: intent.id,
    providerCheckoutRef: intent.provider_checkout_ref, providerPaymentRef: `initial-payment:${key}`,
    providerSubscriptionRef: subscription.provider_subscription_ref, providerMandateRef: intent.provider_mandate_ref,
    amount: intent.amount, currency: intent.currency, priceId: intent.price_id, priceVersion: intent.price_version,
    settledAt: ACTIVATED_AT }, new Date("2026-08-10T10:01:00.000Z")) as any;
  return result.subscriptionId as string;
}

function renewalEvent(subscriptionId: string, suffix: string, eventType: VerifiedProviderPaymentEvent["eventType"],
  settledAt?: string): VerifiedProviderPaymentEvent {
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(subscriptionId) as any;
  const price = getDb().prepare("select * from product_prices where id=?").get(subscription.billing_price_id) as any;
  return { provider: subscription.provider, environment: subscription.provider_environment,
    accountId: subscription.provider_account_id, providerEventId: `renewal:${suffix}`, eventType, subscriptionId,
    providerPaymentRef: `renewal-payment:${suffix}`, providerAttemptRef: `attempt:${suffix}`,
    providerInvoiceRef: `invoice:${suffix}`, providerSubscriptionRef: subscription.provider_subscription_ref,
    amount: price.unit_amount, currency: price.currency, priceId: price.id, priceVersion: price.version,
    attemptedAt: settledAt ?? subscription.current_period_end, settledAt: settledAt ?? subscription.current_period_end };
}

function enterGrace(subscriptionId: string, suffix = "failed") {
  const subscription = getDb().prepare("select current_period_end from subscriptions where id=?")
    .get(subscriptionId) as any;
  return processVerifiedPaymentEvent(renewalEvent(subscriptionId, suffix, "renewal_failed"),
    new Date(subscription.current_period_end)) as any;
}

beforeEach(async () => {
  useInMemoryDb();
  stopRenewalRetries.mockClear();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,
    owning_team,registry_status) values(?,?,'Magical Math','Math','icon-abacus','learning','team','active')`)
    .run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("nt001-bi003-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "30000000-0000-4000-8000-000000000001" }, "2026-08-10").learner.id;
  productId = defineProductVersion({ id: "product-nt001-bi003", slug: "nt001-bi003-monthly", name: "Math Monthly",
    subdomain: "math.example.test", planReference: "plan-nt001-bi003", priceInr: 299,
    productType: "individual_app", version: 1, appIds: [APP_ID] }).id;
});

describe("NT-001 real wiring: BI-003 grace-expired (AT-NT-001-15 family)", () => {
  it("expiring a grace subscription enqueues exactly one billing_grace_expired notification", () => {
    const subscriptionId = activate();
    enterGrace(subscriptionId);
    const result = runGraceExpirySweep("billing-recovery", { limit: 100, runIdempotencyKey: "nt001-grace-run" },
      { now: new Date("2026-09-17T10:00:00.000Z"), adapters: { "contract-provider": provider } });
    expect(result).toMatchObject({ scanned: 1, expired: 1 });
    const intents = getDb().prepare(
      "select * from transactional_notification_intents where source_event_key like 'grace-expired:%'",
    ).all() as any[];
    expect(intents).toHaveLength(1);
    expect(intents[0].notification_type).toBe("billing_grace_expired");
    expect(intents[0].parent_id).toBe(parentId);
    expect(JSON.parse(intents[0].safe_variables)).toMatchObject({ subscriptionLabel: "Math Monthly" });
  });

  it("a repeated sweep run does not create a second notification for the same expiry", () => {
    const subscriptionId = activate();
    enterGrace(subscriptionId);
    const input = { limit: 100, runIdempotencyKey: "nt001-grace-run-repeat" };
    runGraceExpirySweep("billing-recovery", input,
      { now: new Date("2026-09-17T10:00:00.000Z"), adapters: { "contract-provider": provider } });
    runGraceExpirySweep("billing-recovery", input,
      { now: new Date("2026-09-17T10:00:01.000Z"), adapters: { "contract-provider": provider } });
    const intents = getDb().prepare(
      "select * from transactional_notification_intents where source_event_key like 'grace-expired:%'",
    ).all() as any[];
    expect(intents).toHaveLength(1);
  });
});
