import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { disableSubscriptionAutoRenewal, processVerifiedPaymentEvent, reconcileBilling } from "@/lib/billing/bi002-service";
import { createPaymentMethodUpdateSession, getPaymentRecoveryStatus, queueRoutineRecoveryNotification,
  runGraceExpirySweep } from "@/lib/billing/bi003-service";
import { evaluateAccessFresh } from "@/lib/entitlement-access/service";
import { BillingAssignmentError } from "@/lib/billing/errors";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter, VerifiedProviderPaymentEvent } from "@/lib/billing/provider-adapter";
import { repositoryScopeRegistry, supabaseTableAccess } from "@/lib/db/access-boundaries";

const APP_ID = "app-bi003-math";
const ACCOUNT_ID = "acct-bi003";
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
  parentId = (await sqliteAuthAdapter.signUp("bi003-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = (await createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "30000000-0000-4000-8000-000000000001" }, "2026-08-10")).learner.id;
  productId = defineProductVersion({ id: "product-bi003", slug: "bi003-monthly", name: "Math Monthly",
    subdomain: "math.example.test", planReference: "plan-bi003", priceInr: 299,
    productType: "individual_app", version: 1, appIds: [APP_ID] }).id;
});

describe("BI-003 grace entry and controlled access", () => {
  it("AT-BI-003-01..05 enters exactly 168h grace at the paid boundary without a period or renewed event", () => {
    const subscriptionId = activate();
    const beforePeriods = (getDb().prepare("select count(*) n from billing_periods").get() as any).n;
    const result = enterGrace(subscriptionId);
    const row = getDb().prepare("select * from subscriptions where id=?").get(subscriptionId) as any;
    expect(result).toMatchObject({ paymentState: "past_due_grace", graceStartedAt: row.current_period_end });
    expect(new Date(row.grace_ends_at).getTime() - new Date(row.grace_started_at).getTime()).toBe(168 * 3600_000);
    expect((getDb().prepare("select count(*) n from billing_periods").get() as any).n).toBe(beforePeriods);
    expect((getDb().prepare("select count(*) n from account_events where event_type='subscription_renewed'")
      .get() as any).n).toBe(0);
  });

  it("AT-BI-003-04 intentional cancellation and a pre-boundary failure do not start grace", async () => {
    const cancelled = activate("cancelled");
    const row = getDb().prepare("select version,current_period_end from subscriptions where id=?").get(cancelled) as any;
    disableSubscriptionAutoRenewal(parentId, cancelled, { expectedVersion: row.version,
      idempotencyKey: "cancel-before-failure" }, { adapter: provider });
    processVerifiedPaymentEvent(renewalEvent(cancelled, "cancelled", "renewal_failed"), new Date(row.current_period_end));
    expect((getDb().prepare("select grace_ends_at from subscriptions where id=?").get(cancelled) as any).grace_ends_at).toBeNull();

    learnerId = (await createLearner(parentId, { displayName: "Ravi", dateOfBirth: "2017-04-12",
      idempotencyKey: "30000000-0000-4000-8000-000000000002" }, "2026-08-10")).learner.id;
    const early = activate("early");
    processVerifiedPaymentEvent(renewalEvent(early, "early", "renewal_failed", "2026-09-09T10:00:00.000Z"),
      new Date("2026-09-09T10:00:00.000Z"));
    expect((getDb().prepare("select payment_state from subscriptions where id=?").get(early) as any).payment_state)
      .toBe("renewal_failed");
  });

  it("AT-BI-003-06..09 exposes restricted grace access using the old period and creates no allocation", () => {
    const subscriptionId = activate(); enterGrace(subscriptionId);
    const batches = (getDb().prepare("select count(*) n from learner_app_standard_credit_batches").get() as any).n;
    const access = evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "test",
      useCase: "start", now: new Date("2026-09-11T10:00:00.000Z") });
    expect(access).toMatchObject({ allowed: true, state: "grace" });
    expect((getDb().prepare("select count(*) n from learner_app_standard_credit_batches").get() as any).n).toBe(batches);
    expect((getDb().prepare("select current_period_end from subscriptions where id=?").get(subscriptionId) as any)
      .current_period_end).toBe("2026-09-10T10:00:00.000Z");
  });

  it("AT-BI-003-11/12/14/38 lazily blocks new access at cutoff and preserves progress", () => {
    const subscriptionId = activate(); enterGrace(subscriptionId);
    getDb().prepare("insert into learner_app_progress(learner_id,app_id,current_level_key,app_state) values(?,?,?,?)")
      .run(learnerId, APP_ID, "level-1", "safe-state");
    const access = evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "test", useCase: "start",
      now: new Date("2026-09-17T10:00:00.000Z") });
    expect(access.allowed).toBe(false);
    expect((getDb().prepare("select payment_state from subscriptions where id=?").get(subscriptionId) as any).payment_state)
      .toBe("inactive_nonpayment");
    expect((getDb().prepare("select app_state from learner_app_progress where learner_id=? and app_id=?")
      .get(learnerId, APP_ID) as any).app_state).toBe("safe-state");
  });
});

describe("BI-003 retry, recovery and parent recovery UX", () => {
  it("AT-BI-003-15/16/33 stores each provider retry once and never extends grace", () => {
    const subscriptionId = activate(); enterGrace(subscriptionId, "first");
    const deadline = (getDb().prepare("select grace_ends_at from subscriptions where id=?").get(subscriptionId) as any)
      .grace_ends_at;
    processVerifiedPaymentEvent(renewalEvent(subscriptionId, "retry", "retry_failed", "2026-09-12T10:00:00.000Z"),
      new Date("2026-09-12T10:00:01.000Z"));
    expect((getDb().prepare("select count(*) n from renewal_payment_attempts where subscription_id=?")
      .get(subscriptionId) as any).n).toBe(2);
    expect((getDb().prepare("select grace_ends_at from subscriptions where id=?").get(subscriptionId) as any).grace_ends_at)
      .toBe(deadline);
  });

  it("AT-BI-003-17..21/40 timely recovery creates one anchored period, clears grace and preserves identity", () => {
    const subscriptionId = activate(); enterGrace(subscriptionId);
    const before = getDb().prepare("select * from subscriptions where id=?").get(subscriptionId) as any;
    const result = processVerifiedPaymentEvent(renewalEvent(subscriptionId, "recovered", "payment_recovered",
      "2026-09-14T10:00:00.000Z"), new Date("2026-09-14T10:00:02.000Z")) as any;
    const after = getDb().prepare("select * from subscriptions where id=?").get(subscriptionId) as any;
    expect(result.resultCode).toBe("SUBSCRIPTION_PAYMENT_RECOVERED");
    expect(after).toMatchObject({ status: "active", payment_state: "paid", grace_started_at: null,
      grace_ends_at: null, purchaser_parent_id: before.purchaser_parent_id,
      assigned_learner_id: before.assigned_learner_id, product_id: before.product_id,
      billing_anchor_at: before.billing_anchor_at, current_period_start: before.current_period_end });
    expect((getDb().prepare("select count(*) n from billing_periods where subscription_id=?")
      .get(subscriptionId) as any).n).toBe(2);
    expect((getDb().prepare("select count(*) n from entitlement_cycles where subscription_id=?")
      .get(subscriptionId) as any).n).toBe(2);
  });

  it("AT-BI-003-22/23 queues safe initial notice and caps routine recovery notices to one per 24h", async () => {
    const subscriptionId = activate(); enterGrace(subscriptionId);
    expect((getDb().prepare("select count(*) n from billing_recovery_notifications where notification_type='initial_failure'")
      .get() as any).n).toBe(1);
    const now = new Date("2026-09-12T10:00:00.000Z");
    expect((await queueRoutineRecoveryNotification(subscriptionId, now)).queued).toBe(true);
    expect((await queueRoutineRecoveryNotification(subscriptionId, new Date("2026-09-13T09:59:59.000Z"))).queued).toBe(false);
    const context = (getDb().prepare("select safe_context_json from billing_recovery_notifications limit 1").get() as any)
      .safe_context_json;
    expect(context).not.toMatch(/card|cvv|upi.?pin/i);
  });

  it("AT-BI-003-24/25 creates an idempotent provider-hosted update session without marking payment paid", async () => {
    const subscriptionId = activate(); enterGrace(subscriptionId);
    const version = (getDb().prepare("select version from subscriptions where id=?").get(subscriptionId) as any).version;
    const input = { expectedVersion: version, idempotencyKey: "update-1" };
    const first = await createPaymentMethodUpdateSession(parentId, subscriptionId, input, { adapter: provider,
      now: new Date("2026-09-12T10:00:00.000Z") });
    expect(await createPaymentMethodUpdateSession(parentId, subscriptionId, input, { adapter: provider,
      now: new Date("2026-09-12T10:00:01.000Z") })).toEqual(first);
    expect(first).toMatchObject({ paymentState: "past_due_grace", paymentMethodUpdateIsNotPayment: true });
    expect((await getPaymentRecoveryStatus(parentId, subscriptionId, new Date("2026-09-12T10:01:00.000Z"))).paymentState)
      .toBe("past_due_grace");
  });

  it("AT-BI-003-26 reconciliation applies a missing timely recovery through the same event transition", () => {
    const subscriptionId = activate(); enterGrace(subscriptionId);
    const event = renewalEvent(subscriptionId, "reconcile-recovery", "payment_recovered",
      "2026-09-14T10:00:00.000Z");
    const adapter = { ...provider, listReconciliationEvents() { return { events: [event], nextCursor: null }; } };
    const result = reconcileBilling("billing-reconcile", { provider: "contract-provider", environment: "test",
      startDate: "2026-09-10T00:00:00.000Z", endDate: "2026-09-18T00:00:00.000Z", limit: 100,
      runIdempotencyKey: "bi003-reconcile" }, { now: new Date("2026-09-18T10:00:00.000Z"), adapter }) as any;
    expect(result.matched).toBe(1);
    expect((getDb().prepare("select payment_state from subscriptions where id=?").get(subscriptionId) as any).payment_state)
      .toBe("paid");
  });
});

describe("BI-003 cutoff, ordering and boundaries", () => {
  it("AT-BI-003-27..29 expires once, emits cutoff and stops provider retries", async () => {
    const subscriptionId = activate(); enterGrace(subscriptionId);
    const input = { limit: 100, runIdempotencyKey: "grace-run" };
    const first = await runGraceExpirySweep("billing-recovery", input, { now: new Date("2026-09-17T10:00:00.000Z"),
      adapters: { "contract-provider": provider } });
    expect(await runGraceExpirySweep("billing-recovery", input, { now: new Date("2026-09-17T10:00:01.000Z"),
      adapters: { "contract-provider": provider } })).toEqual(first);
    expect(first).toMatchObject({ scanned: 1, expired: 1 });
    expect(stopRenewalRetries).toHaveBeenCalledOnce();
    expect((getDb().prepare("select count(*) n from account_events where event_type='subscription_grace_expired'")
      .get() as any).n).toBe(1);
  });

  it("AT-BI-003-30/32 allows delayed delivery of timely settlement after expiry and has one final paid period", async () => {
    const subscriptionId = activate(); enterGrace(subscriptionId);
    await runGraceExpirySweep("billing-recovery", { limit: 100, runIdempotencyKey: "expire-before-delivery" },
      { now: new Date("2026-09-17T10:00:01.000Z"), adapters: { "contract-provider": provider } });
    processVerifiedPaymentEvent(renewalEvent(subscriptionId, "delayed", "delayed_settlement",
      "2026-09-17T09:59:59.000Z"), new Date("2026-09-18T10:00:00.000Z"));
    expect((getDb().prepare("select payment_state from subscriptions where id=?").get(subscriptionId) as any).payment_state)
      .toBe("paid");
    expect((getDb().prepare("select count(*) n from billing_periods where subscription_id=?")
      .get(subscriptionId) as any).n).toBe(2);
  });

  it("AT-BI-003-31 rejects a payment settled after the deadline without silent reactivation", async () => {
    const subscriptionId = activate(); enterGrace(subscriptionId);
    await runGraceExpirySweep("billing-recovery", { limit: 100, runIdempotencyKey: "late-expire" },
      { now: new Date("2026-09-17T10:00:01.000Z"), adapters: { "contract-provider": provider } });
    expect(() => processVerifiedPaymentEvent(renewalEvent(subscriptionId, "late", "payment_recovered",
      "2026-09-17T10:00:01.000Z"), new Date("2026-09-17T10:00:02.000Z")))
      .toThrow(new BillingAssignmentError("PAYMENT_RECOVERY_WINDOW_EXPIRED"));
    expect((getDb().prepare("select payment_state from subscriptions where id=?").get(subscriptionId) as any).payment_state)
      .toBe("inactive_nonpayment");
  });

  it("AT-BI-003-34 cancellation during grace keeps the exact existing deadline", () => {
    const subscriptionId = activate(); enterGrace(subscriptionId);
    const row = getDb().prepare("select version,grace_ends_at from subscriptions where id=?").get(subscriptionId) as any;
    disableSubscriptionAutoRenewal(parentId, subscriptionId, { expectedVersion: row.version,
      idempotencyKey: "cancel-in-grace" }, { adapter: provider });
    expect(getDb().prepare("select auto_renew_enabled,grace_ends_at from subscriptions where id=?")
      .get(subscriptionId)).toEqual({ auto_renew_enabled: 0, grace_ends_at: row.grace_ends_at });
  });

  it("AT-BI-003-35..37 exposes no grace extension or app repository and stores only safe references", () => {
    expect(Object.keys(supabaseTableAccess)).toContain("renewal_payment_attempts");
    expect(Object.keys(repositoryScopeRegistry).some((path) => path.startsWith("apps/"))).toBe(false);
    expect(getDb().prepare("pragma table_info(subscriptions)").all().map((row: any) => row.name))
      .not.toContain("manual_grace_extension");
  });

  it("AT-BI-003-39 rolls back recovery when its atomic event write fails", () => {
    const subscriptionId = activate(); enterGrace(subscriptionId);
    getDb().exec("drop table account_events");
    expect(() => processVerifiedPaymentEvent(renewalEvent(subscriptionId, "atomic", "payment_recovered",
      "2026-09-14T10:00:00.000Z"), new Date("2026-09-14T10:00:01.000Z"))).toThrow();
    expect((getDb().prepare("select count(*) n from billing_periods where subscription_id=?")
      .get(subscriptionId) as any).n).toBe(1);
    expect((getDb().prepare("select payment_state from subscriptions where id=?").get(subscriptionId) as any).payment_state)
      .toBe("past_due_grace");
  });
});
