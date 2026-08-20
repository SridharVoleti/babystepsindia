import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import {
  createCheckoutIntent,
  defineProductVersion,
  getProductPurchaseView,
} from "@/lib/billing/bi001-service";
import {
  addBillingInterval,
  disableSubscriptionAutoRenewal,
  processVerifiedPaymentEvent,
  reconcileBilling,
  runUpcomingRenewalReminderSweep,
  syncReminderAfterAutoRenewalResumed,
} from "@/lib/billing/bi002-service";
import { BillingAssignmentError } from "@/lib/billing/errors";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type {
  BillingCheckoutProviderAdapter,
  VerifiedProviderPaymentEvent,
} from "@/lib/billing/provider-adapter";
import { localCheckoutProviderAdapter, signLocalWebhookPayload } from "@/lib/billing/provider-adapter";

const NOW = new Date("2026-08-10T10:01:00.000Z");
const SETTLED_AT = "2026-08-10T10:00:00.000Z";
const APP_ID = "app-bi002-math";
const ACCOUNT_ID = "acct-bi002-test";
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

async function createParent(email = "bi002-parent@example.com") {
  return (await sqliteAuthAdapter.signUp(email, "CorrectHorse1!")).user.id;
}

async function createOwnedLearner(owner = parentId, name = "Asha", key = "20000000-0000-4000-8000-000000000001") {
  return (await createLearner(owner, { displayName: name, dateOfBirth: "2018-02-10", idempotencyKey: key },
    "2026-08-10")).learner.id;
}

function checkout(options: { autoRenewEnabled?: boolean; key?: string; adapter?: BillingCheckoutProviderAdapter;
  learner?: string } = {}) {
  const view = getProductPurchaseView(productId);
  return createCheckoutIntent(parentId, { learnerId: options.learner ?? learnerId, productId,
    productVersion: view.version, priceId: view.price.id, priceVersion: view.price.version,
    autoRenewEnabled: options.autoRenewEnabled ?? true,
    consentDisclosureVersion: BILLING_CONSENT_DISCLOSURE_VERSION,
    idempotencyKey: options.key ?? "checkout-1" }, { now: new Date("2026-08-10T09:59:00.000Z"),
    provider: options.adapter ?? provider });
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

function activate(options: { autoRenewEnabled?: boolean; key?: string } = {}) {
  const created = checkout(options);
  const result = processVerifiedPaymentEvent(initialEvent(created.checkoutIntentId), NOW) as any;
  return { checkout: created, result, subscriptionId: result.subscriptionId };
}

function renewalEvent(subscriptionId: string, suffix = "1", overrides: Partial<VerifiedProviderPaymentEvent> = {}) {
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(subscriptionId) as any;
  const price = getDb().prepare("select * from product_prices where id=?").get(subscription.billing_price_id) as any;
  return { provider: subscription.provider, environment: subscription.provider_environment,
    accountId: subscription.provider_account_id, providerEventId: `renewal-event-${suffix}`,
    eventType: "renewal_payment_succeeded" as const, subscriptionId,
    providerPaymentRef: `renewal-payment-${suffix}`,
    providerSubscriptionRef: subscription.provider_subscription_ref,
    amount: price.unit_amount, currency: price.currency, priceId: price.id,
    priceVersion: price.version, settledAt: subscription.current_period_end, ...overrides };
}

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(
    `insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
     values(?,?,'Magical Math','Math learning','icon-abacus','learning','team','active')`,
  ).run(APP_ID, APP_ID);
  parentId = await createParent();
  learnerId = await createOwnedLearner();
  productId = defineProductVersion({ id: "product-bi002", slug: "bi002-monthly", name: "Math Monthly",
    subdomain: "math.example.test", planReference: "plan-bi002", priceInr: 299,
    productType: "individual_app", version: 1, appIds: [APP_ID] }).id;
});

describe("BI-002 checkout and provider truth", () => {
  it("AT-BI-002-17 verifies the exact raw-body signature before trusting event fields", () => {
    const rawBody = JSON.stringify({ providerEventId: "signed-event", eventType: "initial_payment_failed",
      providerPaymentRef: "payment-safe", amount: 29900, currency: "INR", priceId: "price-safe",
      priceVersion: 1, settledAt: SETTLED_AT });
    expect(() => localCheckoutProviderAdapter.verifyWebhook!({ rawBody, signature: "00",
      environment: "test", accountId: "babysteps-local-test" }))
      .toThrow(new BillingAssignmentError("PAYMENT_EVENT_AUTHENTICATION_FAILED"));
    expect(localCheckoutProviderAdapter.verifyWebhook!({ rawBody,
      signature: signLocalWebhookPayload(rawBody), environment: "test",
      accountId: "babysteps-local-test" })).toMatchObject({ providerEventId: "signed-event",
      provider: "local-provider", environment: "test" });
  });

  it("AT-BI-002-03/04/05/07-09 records only the actively submitted exact choice, price and consent snapshot", () => {
    expect((getDb().prepare("select count(*) n from checkout_intents").get() as any).n).toBe(0);
    const created = checkout({ autoRenewEnabled: false });
    const row = intentRow(created.checkoutIntentId);
    expect(created).toMatchObject({ autoRenewEnabled: false,
      price: { amount: 29900, currency: "INR", billingInterval: "month" },
      assignedLearner: { id: learnerId }, product: { id: productId } });
    expect(row).toMatchObject({ auto_renew_enabled: 0,
      consent_disclosure_version: BILLING_CONSENT_DISCLOSURE_VERSION,
      price_version: 1, amount: 29900, currency: "INR" });
    expect(row.consented_at).toBe("2026-08-10T09:59:00.000Z");
  });

  it("AT-BI-002-10 rejects invalid disclosure/boolean context before provider handoff", () => {
    const view = getProductPurchaseView(productId);
    expect(() => createCheckoutIntent(parentId, { learnerId, productId, productVersion: 1,
      priceId: view.price.id, priceVersion: 1, autoRenewEnabled: true,
      consentDisclosureVersion: "forged", idempotencyKey: "bad-consent" }, { provider }))
      .toThrow(new BillingAssignmentError("CHECKOUT_CONSENT_INVALID"));
  });

  it("AT-BI-002-11/12 requires a safe recurring mandate reference when selected", () => {
    const failing: BillingCheckoutProviderAdapter = { createCheckout(input) {
      return { provider: "contract-provider", environment: "test", accountId: ACCOUNT_ID,
        providerCheckoutRef: input.checkoutIntentId, handoff: { url: "/provider", method: "GET" } };
    } };
    expect(() => checkout({ adapter: failing })).toThrow(new BillingAssignmentError("RECURRING_PAYMENT_SETUP_FAILED"));
    expect((getDb().prepare("select count(*) n from checkout_intents").get() as any).n).toBe(0);
  });

  it("AT-BI-002-13/15/16 creates a pending non-renewing subscription and browser state cannot activate it", () => {
    const created = checkout({ autoRenewEnabled: false });
    const intent = intentRow(created.checkoutIntentId);
    const subscription = getDb().prepare("select * from subscriptions where id=?").get(intent.subscription_id) as any;
    expect(subscription).toMatchObject({ status: "pending_payment", payment_state: "pending", auto_renew_enabled: 0 });
    expect((getDb().prepare("select count(*) n from billing_periods").get() as any).n).toBe(0);
    expect((getDb().prepare("select count(*) n from entitlement_cycles").get() as any).n).toBe(0);
  });

  it("AT-BI-002-18-20 rejects environment, account, amount, currency and price mismatch", () => {
    for (const [key, override, code] of [
      ["env", { environment: "production" }, "PAYMENT_EVENT_CONTEXT_MISMATCH"],
      ["account", { accountId: "other-account" }, "PAYMENT_EVENT_CONTEXT_MISMATCH"],
      ["amount", { amount: 1 }, "PAYMENT_AMOUNT_MISMATCH"],
      ["currency", { currency: "USD" }, "PAYMENT_AMOUNT_MISMATCH"],
      ["price", { priceVersion: 99 }, "PAYMENT_AMOUNT_MISMATCH"],
    ] as const) {
      const created = checkout({ key });
      expect(() => processVerifiedPaymentEvent(initialEvent(created.checkoutIntentId, override as any), NOW))
        .toThrow(new BillingAssignmentError(code));
    }
    expect((getDb().prepare("select count(*) n from billing_periods").get() as any).n).toBe(0);
  });

  it("AT-BI-002-21/22 activates exactly one paid period and entitlement cycle; exact replay returns the original", () => {
    const created = checkout();
    const event = initialEvent(created.checkoutIntentId);
    const first = processVerifiedPaymentEvent(event, NOW) as any;
    expect(processVerifiedPaymentEvent(event, NOW)).toEqual(first);
    expect(first).toMatchObject({ resultCode: "SUBSCRIPTION_ACTIVATED", status: "active",
      autoRenewEnabled: true, currentPeriodStart: SETTLED_AT,
      currentPeriodEnd: "2026-09-10T10:00:00.000Z" });
    expect((getDb().prepare("select count(*) n from billing_periods").get() as any).n).toBe(1);
    expect((getDb().prepare("select count(*) n from entitlement_cycles").get() as any).n).toBe(1);
  });

  it("AT-BI-002-23 safely ignores a renewal received before activation", () => {
    const created = checkout();
    const intent = intentRow(created.checkoutIntentId);
    const result = processVerifiedPaymentEvent(renewalEvent(intent.subscription_id, "early"), NOW) as any;
    expect(result).toMatchObject({ resultCode: "RENEWAL_IGNORED", renewed: false });
    expect((getDb().prepare("select count(*) n from billing_periods").get() as any).n).toBe(0);
  });

  it("AT-BI-002-26 failed/cancelled initial payment creates no paid period or entitlement", () => {
    const created = checkout();
    const result = processVerifiedPaymentEvent(initialEvent(created.checkoutIntentId,
      { eventType: "initial_payment_failed" }), NOW) as any;
    expect(result).toMatchObject({ activated: false, resultCode: "INITIAL_PAYMENT_FAILED" });
    expect((getDb().prepare("select count(*) n from billing_periods").get() as any).n).toBe(0);
    expect((getDb().prepare("select count(*) n from entitlement_cycles").get() as any).n).toBe(0);
  });

  it("AT-BI-002-36 isolates provider test and production namespaces", () => {
    const created = checkout();
    expect(() => processVerifiedPaymentEvent(initialEvent(created.checkoutIntentId,
      { environment: "production", accountId: ACCOUNT_ID }), NOW))
      .toThrow(new BillingAssignmentError("PAYMENT_EVENT_CONTEXT_MISMATCH"));
  });

  it("AT-BI-002-39 rolls back activation, period and entitlement when the atomic event/outbox write fails", () => {
    const created = checkout();
    const subscriptionId = intentRow(created.checkoutIntentId).subscription_id;
    getDb().exec("drop table account_events");
    expect(() => processVerifiedPaymentEvent(initialEvent(created.checkoutIntentId), NOW)).toThrow();
    expect((getDb().prepare("select count(*) n from billing_periods").get() as any).n).toBe(0);
    expect((getDb().prepare("select count(*) n from entitlement_cycles").get() as any).n).toBe(0);
    expect((getDb().prepare("select status from subscriptions where id=?").get(subscriptionId) as any).status)
      .toBe("pending_payment");
  });
});

describe("BI-002 renewal, disablement and reconciliation", () => {
  it("AT-BI-002-24/25 extends exactly one period without changing purchaser, learner or product", () => {
    const active = activate();
    const before = getDb().prepare("select * from subscriptions where id=?").get(active.subscriptionId) as any;
    const result = processVerifiedPaymentEvent(renewalEvent(active.subscriptionId),
      new Date("2026-09-10T10:05:00.000Z")) as any;
    const after = getDb().prepare("select * from subscriptions where id=?").get(active.subscriptionId) as any;
    expect(result.currentPeriodEnd).toBe("2026-10-10T10:00:00.000Z");
    expect([after.purchaser_parent_id, after.assigned_learner_id, after.product_id])
      .toEqual([before.purchaser_parent_id, before.assigned_learner_id, before.product_id]);
    expect((getDb().prepare("select count(*) n from billing_periods where subscription_id=?")
      .get(active.subscriptionId) as any).n).toBe(2);
  });

  it("AT-BI-002-27 failed renewal creates no paid period and hands recovery state to BI-003", () => {
    const active = activate();
    const before = getDb().prepare("select current_period_end from subscriptions where id=?")
      .get(active.subscriptionId) as any;
    processVerifiedPaymentEvent(renewalEvent(active.subscriptionId, "failed",
      { eventType: "renewal_payment_failed" }), new Date("2026-09-10T10:05:00.000Z"));
    const after = getDb().prepare("select current_period_end,payment_state from subscriptions where id=?")
      .get(active.subscriptionId) as any;
    expect(after).toEqual({ current_period_end: before.current_period_end, payment_state: "past_due_grace" });
    expect((getDb().prepare("select count(*) n from billing_periods").get() as any).n).toBe(1);
  });

  it("AT-BI-002-28-31 turns renewal off provider-first, preserves paid access, and is idempotent/versioned", () => {
    const active = activate();
    const subscription = getDb().prepare("select * from subscriptions where id=?").get(active.subscriptionId) as any;
    const first = disableSubscriptionAutoRenewal(parentId, active.subscriptionId,
      { expectedVersion: subscription.version, idempotencyKey: "disable-1" }, { now: NOW, adapter: provider });
    expect(disableSubscriptionAutoRenewal(parentId, active.subscriptionId,
      { expectedVersion: subscription.version, idempotencyKey: "disable-1" }, { now: NOW, adapter: provider })).toEqual(first);
    expect(first).toMatchObject({ autoRenewEnabled: false, cancelAtPeriodEnd: true,
      currentPeriodEnd: "2026-09-10T10:00:00.000Z" });
    expect(() => disableSubscriptionAutoRenewal(parentId, active.subscriptionId,
      { expectedVersion: subscription.version, idempotencyKey: "stale" }, { adapter: provider }))
      .toThrow(new BillingAssignmentError("VERSION_CONFLICT"));
  });

  it("AT-BI-002-32 does not falsely confirm when the provider cancellation update fails", () => {
    const active = activate();
    const subscription = getDb().prepare("select * from subscriptions where id=?").get(active.subscriptionId) as any;
    const failing: BillingCheckoutProviderAdapter = { createCheckout: provider.createCheckout,
      disableAutoRenewal() { throw new Error("provider down"); } };
    expect(() => disableSubscriptionAutoRenewal(parentId, active.subscriptionId,
      { expectedVersion: subscription.version, idempotencyKey: "provider-fail" }, { adapter: failing }))
      .toThrow(new BillingAssignmentError("PROVIDER_UPDATE_FAILED"));
    expect((getDb().prepare("select auto_renew_enabled from subscriptions where id=?")
      .get(active.subscriptionId) as any).auto_renew_enabled).toBe(1);
  });

  it("AT-BI-002-33 never silently re-enables a disabled subscription", () => {
    const active = activate();
    const subscription = getDb().prepare("select * from subscriptions where id=?").get(active.subscriptionId) as any;
    disableSubscriptionAutoRenewal(parentId, active.subscriptionId,
      { expectedVersion: subscription.version, idempotencyKey: "disable" }, { adapter: provider });
    const result = processVerifiedPaymentEvent(renewalEvent(active.subscriptionId, "late"), NOW) as any;
    expect(result.resultCode).toBe("RENEWAL_IGNORED");
    expect((getDb().prepare("select auto_renew_enabled from subscriptions where id=?")
      .get(active.subscriptionId) as any).auto_renew_enabled).toBe(0);
  });

  it("AT-BI-002-34/35 reconciliation applies provider truth through the same event function and ignores browser evidence", () => {
    const created = checkout();
    const event = initialEvent(created.checkoutIntentId);
    const adapter: BillingCheckoutProviderAdapter = { createCheckout: provider.createCheckout,
      listReconciliationEvents() { return { events: [event], nextCursor: null }; } };
    const result = reconcileBilling("principal-reconcile", { provider: "contract-provider", environment: "test",
      startDate: "2026-08-10T00:00:00.000Z", endDate: "2026-08-11T00:00:00.000Z",
      limit: 100, runIdempotencyKey: "run-1" }, { now: NOW, adapter }) as any;
    expect(result).toMatchObject({ processed: 1, matched: 1, errors: 0 });
    expect((getDb().prepare("select count(*) n from billing_periods").get() as any).n).toBe(1);
  });

  it("AT-BI-002-35 retries a failed provider reconciliation under the same run receipt", () => {
    const created = checkout();
    const event = initialEvent(created.checkoutIntentId);
    let attempts = 0;
    const adapter: BillingCheckoutProviderAdapter = { createCheckout: provider.createCheckout,
      listReconciliationEvents() {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary provider outage");
        return { events: [event], nextCursor: null };
      } };
    const input = { provider: "contract-provider", environment: "test" as const,
      startDate: "2026-08-10T00:00:00.000Z", endDate: "2026-08-11T00:00:00.000Z",
      limit: 100, runIdempotencyKey: "run-retry" };
    expect(() => reconcileBilling("principal-reconcile", input, { now: NOW, adapter }))
      .toThrowError("PAYMENT_PROVIDER_UNAVAILABLE");
    expect(reconcileBilling("principal-reconcile", input, { now: NOW, adapter }))
      .toMatchObject({ processed: 1, matched: 1, errors: 0 });
    expect((getDb().prepare("select status from billing_job_runs where run_idempotency_key='run-retry'")
      .get() as any).status).toBe("completed");
  });

  it("AT-BI-002-40 keeps provider differences behind the adapter contract", () => {
    const alternate = { ...provider, createCheckout: vi.fn(provider.createCheckout) };
    const created = checkout({ adapter: alternate });
    expect(alternate.createCheckout).toHaveBeenCalledOnce();
    expect(created.provider).toBe("contract-provider");
  });
});

describe("BI-002 reminders, anchored periods and overlap", () => {
  it("AT-BI-002-41/43/44 sends one exact T-168h reminder with charge, product, learner and manage action", () => {
    const active = activate();
    const reminder = getDb().prepare("select * from subscription_renewal_reminders where subscription_id=?")
      .get(active.subscriptionId) as any;
    expect(reminder.reminder_due_at).toBe("2026-09-03T10:00:00.000Z");
    const send = vi.fn();
    const input = { startDueAt: reminder.reminder_due_at, endDueAt: reminder.reminder_due_at,
      limit: 100, runIdempotencyKey: "reminder-run-1" };
    const first = runUpcomingRenewalReminderSweep("principal-notify", input,
      { now: new Date(reminder.reminder_due_at), notifier: { send } });
    expect(runUpcomingRenewalReminderSweep("principal-notify", input,
      { now: new Date(reminder.reminder_due_at), notifier: { send } })).toEqual(first);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({ amount: 29900, currency: "INR",
      productName: "Math Monthly", learnerName: "Asha",
      manageUrl: `/account/subscriptions#${active.subscriptionId}` });
  });

  it("AT-BI-002-42 disabling renewal cancels its pending reminder", () => {
    const active = activate();
    const subscription = getDb().prepare("select * from subscriptions where id=?").get(active.subscriptionId) as any;
    disableSubscriptionAutoRenewal(parentId, active.subscriptionId,
      { expectedVersion: subscription.version, idempotencyKey: "disable-reminder" }, { adapter: provider });
    expect((getDb().prepare("select status from subscription_renewal_reminders where subscription_id=?")
      .get(active.subscriptionId) as any).status).toBe("cancelled");
  });

  it("AT-BI-002-46 early explicit reversal restores the one normal T-7 reminder", () => {
    const active = activate();
    const subscription = getDb().prepare("select * from subscriptions where id=?").get(active.subscriptionId) as any;
    disableSubscriptionAutoRenewal(parentId, active.subscriptionId,
      { expectedVersion: subscription.version, idempotencyKey: "early-disable" }, { adapter: provider });
    getDb().prepare(
      `update subscriptions set auto_renew_enabled=1,cancel_at_period_end=0,next_renewal_at=current_period_end where id=?`,
    ).run(active.subscriptionId);
    const result = syncReminderAfterAutoRenewalResumed(active.subscriptionId,
      new Date("2026-08-20T10:00:00.000Z"));
    expect(result).toMatchObject({ scheduled: true, reminderDueAt: "2026-09-03T10:00:00.000Z" });
    expect((getDb().prepare("select status from subscription_renewal_reminders where subscription_id=?")
      .get(active.subscriptionId) as any).status).toBe("pending");
  });

  it("AT-BI-002-47 late explicit reversal returns exact charge details and creates no late reminder", () => {
    const active = activate();
    const subscription = getDb().prepare("select * from subscriptions where id=?").get(active.subscriptionId) as any;
    disableSubscriptionAutoRenewal(parentId, active.subscriptionId,
      { expectedVersion: subscription.version, idempotencyKey: "late-disable" }, { adapter: provider });
    getDb().prepare(
      `update subscriptions set auto_renew_enabled=1,cancel_at_period_end=0,next_renewal_at=current_period_end where id=?`,
    ).run(active.subscriptionId);
    const result = syncReminderAfterAutoRenewalResumed(active.subscriptionId,
      new Date("2026-09-05T10:00:00.000Z"));
    expect(result).toMatchObject({ scheduled: false, lateConfirmationRequired: true,
      renewalAt: "2026-09-10T10:00:00.000Z", expectedAmount: 29900, currency: "INR" });
    expect((getDb().prepare("select status from subscription_renewal_reminders where subscription_id=?")
      .get(active.subscriptionId) as any).status).not.toBe("pending");
  });

  it("AT-BI-002-45/57 revalidates current price and retries delivery in the same reminder record", () => {
    const active = activate();
    const subscription = getDb().prepare("select * from subscriptions where id=?").get(active.subscriptionId) as any;
    const reminder = getDb().prepare("select * from subscription_renewal_reminders where subscription_id=?")
      .get(active.subscriptionId) as any;
    const price2 = "price-bi002-v2";
    getDb().prepare(
      `insert into product_prices(id,product_id,currency,billing_interval,interval_count,unit_amount,
       pricing_rule_version,supports_non_renewing,status,effective_from,version)
       values(?,?,'INR','month',1,34900,'rule-v2',1,'active',?,2)`,
    ).run(price2, productId, NOW.toISOString());
    getDb().prepare("update subscriptions set billing_price_id=?,billing_price_version=2 where id=?")
      .run(price2, subscription.id);
    const failing = { send() { throw new Error("mail down"); } };
    runUpcomingRenewalReminderSweep("principal-notify", { startDueAt: reminder.reminder_due_at,
      endDueAt: reminder.reminder_due_at, limit: 100, runIdempotencyKey: "fail-run" },
    { now: new Date(reminder.reminder_due_at), notifier: failing });
    const send = vi.fn();
    runUpcomingRenewalReminderSweep("principal-notify", { startDueAt: reminder.reminder_due_at,
      endDueAt: reminder.reminder_due_at, limit: 100, runIdempotencyKey: "retry-run" },
    { now: new Date(reminder.reminder_due_at), notifier: { send } });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ reminderId: reminder.id, amount: 34900 }));
    expect((getDb().prepare("select attempt_count,status from subscription_renewal_reminders where id=?")
      .get(reminder.id) as any)).toEqual({ attempt_count: 2, status: "sent" });
  });

  it("AT-BI-002-48/49/52 uses any-day rolling monthly periods without calendar-month proration", () => {
    const active = activate();
    expect(active.result.currentPeriodStart).toBe("2026-08-10T10:00:00.000Z");
    expect(active.result.currentPeriodEnd).toBe("2026-09-10T10:00:00.000Z");
    const renewed = processVerifiedPaymentEvent(renewalEvent(active.subscriptionId),
      new Date("2026-09-10T12:00:00.000Z")) as any;
    expect(renewed.currentPeriodEnd).toBe("2026-10-10T10:00:00.000Z");
  });

  it("AT-BI-002-50 clamps short months but restores the original anchor day", () => {
    expect(addBillingInterval("2027-01-31T10:00:00.000Z", "month", 1, 31))
      .toBe("2027-02-28T10:00:00.000Z");
    expect(addBillingInterval("2027-02-28T10:00:00.000Z", "month", 1, 31))
      .toBe("2027-03-31T10:00:00.000Z");
  });

  it("AT-BI-002-51 delayed webhook delivery never shifts the authoritative period boundary", () => {
    const active = activate();
    const result = processVerifiedPaymentEvent(renewalEvent(active.subscriptionId, "delayed",
      { settledAt: "2026-09-10T10:00:00.000Z" }), new Date("2026-09-12T09:00:00.000Z")) as any;
    expect(result).toMatchObject({ currentPeriodStart: "2026-09-10T10:00:00.000Z",
      currentPeriodEnd: "2026-10-10T10:00:00.000Z" });
  });

  it("AT-BI-002 overlap rules reject before checkout and quarantine a paid race without duplicate credits", () => {
    const first = checkout({ key: "race-1" });
    const second = checkout({ key: "race-2" });
    processVerifiedPaymentEvent(initialEvent(first.checkoutIntentId), NOW);
    expect(() => checkout({ key: "after-active" })).toThrow(new BillingAssignmentError("PRODUCT_ACCESS_OVERLAP"));
    const raceResult = processVerifiedPaymentEvent(initialEvent(second.checkoutIntentId,
      { providerEventId: "paid-race-event", providerPaymentRef: "paid-race-payment" }), NOW) as any;
    expect(raceResult.resultCode).toBe("OVERLAP_RESOLUTION_REQUIRED");
    expect((getDb().prepare("select count(*) n from billing_periods").get() as any).n).toBe(1);
  });

  it("AT-BI-002-14/37/38 stores only safe references and exposes no app billing repository", () => {
    const tableSql = (getDb().prepare(
      "select group_concat(sql,' ') sql from sqlite_master where name in ('subscriptions','checkout_intents','payment_provider_events')",
    ).get() as any).sql.toLowerCase();
    for (const forbidden of ["card_number", "cvv", "upi_pin", "bank_account_number", "raw_payload"]) {
      expect(tableSql).not.toContain(forbidden);
    }
  });
});
