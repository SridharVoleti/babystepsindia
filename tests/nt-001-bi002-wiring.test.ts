// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { processVerifiedPaymentEvent, runUpcomingRenewalReminderSweep } from "@/lib/billing/bi002-service";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter, VerifiedProviderPaymentEvent } from "@/lib/billing/provider-adapter";

const NOW = new Date("2026-08-10T10:01:00.000Z");
const SETTLED_AT = "2026-08-10T10:00:00.000Z";
const APP_ID = "app-nt001-bi002-math";
const ACCOUNT_ID = "acct-nt001-bi002-test";
let parentId: string;
let learnerId: string;
let productId: string;

const provider: BillingCheckoutProviderAdapter = {
  createCheckout(input) {
    return { provider: "contract-provider", environment: "test", accountId: ACCOUNT_ID,
      providerCheckoutRef: `checkout:${input.checkoutIntentId}`,
      providerSubscriptionRef: `provider-sub:${input.checkoutIntentId}`,
      providerMandateRef: input.autoRenewEnabled ? `mandate:${input.checkoutIntentId}` : undefined,
      handoff: { url: `/provider/${input.checkoutIntentId}`, method: "GET" } };
  },
  disableAutoRenewal() { return { confirmed: true }; },
  listReconciliationEvents() { return { events: [], nextCursor: null }; },
};

function checkout(options: { autoRenewEnabled?: boolean; key?: string } = {}) {
  const view = getProductPurchaseView(productId);
  return createCheckoutIntent(parentId, { learnerId, productId, productVersion: view.version,
    priceId: view.price.id, priceVersion: view.price.version, autoRenewEnabled: options.autoRenewEnabled ?? true,
    consentDisclosureVersion: BILLING_CONSENT_DISCLOSURE_VERSION, idempotencyKey: options.key ?? "checkout-1" },
    { now: new Date("2026-08-10T09:59:00.000Z"), provider });
}

function intentRow(checkoutIntentId: string) {
  return getDb().prepare("select * from checkout_intents where id=?").get(checkoutIntentId) as any;
}

function initialEvent(checkoutIntentId: string, overrides: Partial<VerifiedProviderPaymentEvent> = {}): VerifiedProviderPaymentEvent {
  const intent = intentRow(checkoutIntentId);
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(intent.subscription_id) as any;
  return { provider: intent.provider, environment: intent.provider_environment, accountId: intent.provider_account_id,
    providerEventId: `event:${checkoutIntentId}`, eventType: "initial_payment_succeeded",
    checkoutIntentId, providerCheckoutRef: intent.provider_checkout_ref,
    providerPaymentRef: `payment:${checkoutIntentId}`, providerSubscriptionRef: subscription.provider_subscription_ref,
    providerCustomerRef: "customer-safe-ref", providerPaymentMethodRef: "payment-method-safe-ref",
    providerMandateRef: intent.provider_mandate_ref ?? undefined,
    amount: intent.amount, currency: intent.currency, priceId: intent.price_id,
    priceVersion: intent.price_version, settledAt: SETTLED_AT, ...overrides };
}

function activate() {
  const created = checkout();
  const result = processVerifiedPaymentEvent(initialEvent(created.checkoutIntentId), NOW) as any;
  return { checkout: created, subscriptionId: result.subscriptionId as string };
}

function renewalEvent(subscriptionId: string, suffix: string, overrides: Partial<VerifiedProviderPaymentEvent> = {}) {
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(subscriptionId) as any;
  const price = getDb().prepare("select * from product_prices where id=?").get(subscription.billing_price_id) as any;
  return { provider: subscription.provider, environment: subscription.provider_environment,
    accountId: subscription.provider_account_id, providerEventId: `renewal-event-${suffix}`,
    eventType: "renewal_payment_succeeded" as const, subscriptionId,
    providerPaymentRef: `renewal-payment-${suffix}`, providerSubscriptionRef: subscription.provider_subscription_ref,
    amount: price.unit_amount, currency: price.currency, priceId: price.id,
    priceVersion: price.version, settledAt: subscription.current_period_end, ...overrides };
}

function intentsFor(sourceEventKeyPrefix: string) {
  return getDb().prepare(
    "select * from transactional_notification_intents where source_event_key like ? order by created_at",
  ).all(`${sourceEventKeyPrefix}%`) as any[];
}

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(
    `insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
     values(?,?,'Magical Math','Math learning','icon-abacus','learning','team','active')`,
  ).run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("nt001-bi002-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = (await createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "20000000-0000-4000-8000-000000000001" }, "2026-08-10")).learner.id;
  productId = defineProductVersion({ id: "product-nt001-bi002", slug: "nt001-bi002-monthly", name: "Math Monthly",
    subdomain: "math.example.test", planReference: "plan-nt001-bi002", priceInr: 299,
    productType: "individual_app", version: 1, appIds: [APP_ID] }).id;
});

describe("NT-001 real wiring: BI-002 (AT-NT-001-14/15/16)", () => {
  it("AT-NT-001-15: a failed renewal that enters grace enqueues exactly one billing_grace_started notification", () => {
    const active = activate();
    processVerifiedPaymentEvent(renewalEvent(active.subscriptionId, "failed",
      { eventType: "renewal_payment_failed" }), new Date("2026-09-10T10:05:00.000Z"));
    const intents = intentsFor("grace-started:");
    expect(intents).toHaveLength(1);
    expect(intents[0].notification_type).toBe("billing_grace_started");
    expect(intents[0].parent_id).toBe(parentId);
    expect(JSON.parse(intents[0].safe_variables)).toMatchObject({ subscriptionLabel: "Math Monthly" });
  });

  it("a replayed failed-renewal provider event does not create a second grace-started notification", () => {
    const active = activate();
    const event = renewalEvent(active.subscriptionId, "failed", { eventType: "renewal_payment_failed" });
    const now = new Date("2026-09-10T10:05:00.000Z");
    processVerifiedPaymentEvent(event, now);
    // BI-002's own payment_provider_events idempotency returns the cached
    // receipt on a byte-identical replay without re-running applyFailedRenewal.
    processVerifiedPaymentEvent(event, now);
    expect(intentsFor("grace-started:")).toHaveLength(1);
  });

  it("AT-NT-001-16: a payment recovered from grace enqueues exactly one billing_payment_recovered notification", () => {
    const active = activate();
    processVerifiedPaymentEvent(renewalEvent(active.subscriptionId, "failed",
      { eventType: "renewal_payment_failed" }), new Date("2026-09-10T10:05:00.000Z"));
    processVerifiedPaymentEvent(renewalEvent(active.subscriptionId, "recovered",
      { settledAt: "2026-09-12T00:00:00.000Z" }), new Date("2026-09-12T00:00:00.000Z"));
    const intents = intentsFor("payment-recovered:");
    expect(intents).toHaveLength(1);
    expect(intents[0].notification_type).toBe("billing_payment_recovered");
    expect(intents[0].parent_id).toBe(parentId);
  });

  it("AT-NT-001-14: the T-7 sweep enqueues a billing_renewal_reminder alongside the legacy notifier", () => {
    const active = activate();
    const reminder = getDb().prepare("select * from subscription_renewal_reminders where subscription_id=?")
      .get(active.subscriptionId) as any;
    const send = vi.fn();
    runUpcomingRenewalReminderSweep("principal-notify", { startDueAt: reminder.reminder_due_at,
      endDueAt: reminder.reminder_due_at, limit: 100, runIdempotencyKey: "nt001-reminder-run-1" },
      { now: new Date(reminder.reminder_due_at), notifier: { send } });
    expect(send).toHaveBeenCalledOnce();
    const intents = intentsFor(`renewal-reminder:${active.subscriptionId}:`);
    expect(intents).toHaveLength(1);
    expect(intents[0].notification_type).toBe("billing_renewal_reminder");
    expect(JSON.parse(intents[0].safe_variables)).toMatchObject({ subscriptionLabel: "Math Monthly" });
  });

  it("delivery failure never rolls back the already-committed billing transaction (AT-NT-001-27)", () => {
    const active = activate();
    // Soft-delete-equivalent stress: grace-started still commits and the
    // billing state transition is unaffected even though the parent has no
    // verified email yet (delivery will later resolve blocked_recipient,
    // not roll back anything here).
    processVerifiedPaymentEvent(renewalEvent(active.subscriptionId, "failed",
      { eventType: "renewal_payment_failed" }), new Date("2026-09-10T10:05:00.000Z"));
    const subscription = getDb().prepare("select payment_state from subscriptions where id=?")
      .get(active.subscriptionId) as any;
    expect(subscription.payment_state).toBe("past_due_grace");
  });
});
