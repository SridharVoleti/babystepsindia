import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { processVerifiedPaymentEvent } from "@/lib/billing/bi002-service";
import { cancelSubscriptionAtPeriodEnd, getCancellationBillingStatus,
  processVerifiedRecurringAgreementEvent, resumeSubscriptionAutoRenewal } from "@/lib/billing/bi004-service";
import { evaluateAccessFresh } from "@/lib/entitlement-access/service";
import { startLearnerSession, LearnerSessionError } from "@/lib/learning-session/gateway";
import { BillingAssignmentError } from "@/lib/billing/errors";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter, VerifiedProviderPaymentEvent,
  VerifiedProviderRecurringAgreementEvent } from "@/lib/billing/provider-adapter";
import { repositoryScopeRegistry, supabaseTableAccess } from "@/lib/db/access-boundaries";

const APP_ID = "app-bi004-math";
const ACCOUNT_ID = "acct-bi004";
const ACTIVATED_AT = "2026-08-10T10:00:00.000Z";
const CANCEL_AT = new Date("2026-08-15T10:00:00.000Z");
let parentId: string;
let learnerId: string;
let productId: string;
let mandateValid = true;

const disableAutoRenewal = vi.fn(() => ({ confirmed: true as const }));
const enableAutoRenewal = vi.fn(() => ({ confirmed: true as const }));
const provider: BillingCheckoutProviderAdapter = {
  createCheckout(input) { return { provider: "contract-provider", environment: "test", accountId: ACCOUNT_ID,
    providerCheckoutRef: `checkout:${input.checkoutIntentId}`,
    providerSubscriptionRef: `provider-sub:${input.checkoutIntentId}`,
    providerMandateRef: `mandate:${input.checkoutIntentId}`,
    handoff: { url: `/provider/${input.checkoutIntentId}`, method: "GET" } }; },
  disableAutoRenewal,
  getRecurringAgreementStatus() { return { status: mandateValid ? "valid" : "invalid" }; },
  enableAutoRenewal,
  createRecurringAgreementSetupSession(input) { return { providerSessionRef: `setup:${input.idempotencyKey}`,
    handoffUrl: `/provider/recurring/${input.subscriptionId}`, expiresAt: input.expiresAt }; },
  listReconciliationEvents() { return { events: [], nextCursor: null }; },
};

async function checkout(key = "checkout") {
  const view = await getProductPurchaseView(productId);
  return await createCheckoutIntent(parentId, { learnerId, productId, productVersion: view.version,
    priceId: view.price.id, priceVersion: view.price.version, autoRenewEnabled: true,
    consentDisclosureVersion: BILLING_CONSENT_DISCLOSURE_VERSION, idempotencyKey: key },
  { now: new Date("2026-08-10T09:59:00.000Z"), provider });
}

async function activate(key = "checkout") {
  const created = await checkout(key);
  const intent = getDb().prepare("select * from checkout_intents where id=?").get(created.checkoutIntentId) as any;
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(intent.subscription_id) as any;
  const event: VerifiedProviderPaymentEvent = { provider: intent.provider,
    environment: intent.provider_environment, accountId: intent.provider_account_id,
    providerEventId: `activation:${key}`, eventType: "initial_payment_succeeded",
    checkoutIntentId: intent.id, providerCheckoutRef: intent.provider_checkout_ref,
    providerPaymentRef: `payment:${key}`, providerSubscriptionRef: subscription.provider_subscription_ref,
    providerMandateRef: intent.provider_mandate_ref, amount: intent.amount, currency: intent.currency,
    priceId: intent.price_id, priceVersion: intent.price_version, settledAt: ACTIVATED_AT };
  return (await processVerifiedPaymentEvent(event, new Date("2026-08-10T10:01:00.000Z")) as any)
    .subscriptionId as string;
}

function row(subscriptionId: string) {
  return getDb().prepare("select * from subscriptions where id=?").get(subscriptionId) as any;
}

async function cancel(subscriptionId: string, key = "cancel", now = CANCEL_AT) {
  const subscription = row(subscriptionId);
  return (await cancelSubscriptionAtPeriodEnd(parentId, subscriptionId,
    { expectedVersion: subscription.version, idempotencyKey: key }, { now, adapter: provider })) as any;
}

async function resume(subscriptionId: string, key = "resume", now = new Date("2026-08-20T10:00:00.000Z")) {
  const subscription = row(subscriptionId);
  return (await resumeSubscriptionAutoRenewal(parentId, subscriptionId,
    { expectedVersion: subscription.version, idempotencyKey: key }, { now, adapter: provider })) as any;
}

function setupEvent(subscriptionId: string, eventType: VerifiedProviderRecurringAgreementEvent["eventType"],
  suffix = "1"): VerifiedProviderRecurringAgreementEvent {
  const subscription = row(subscriptionId);
  const setup = getDb().prepare(
    "select provider_session_ref from recurring_agreement_setup_sessions where subscription_id=? order by created_at desc limit 1",
  ).get(subscriptionId) as any;
  return { provider: subscription.provider, environment: subscription.provider_environment,
    accountId: subscription.provider_account_id, providerEventId: `mandate-event:${suffix}`, eventType,
    subscriptionId, providerSubscriptionRef: subscription.provider_subscription_ref,
    providerMandateRef: eventType === "recurring_agreement_confirmed" ? `new-mandate:${suffix}` : undefined,
    providerSetupSessionRef: setup.provider_session_ref, occurredAt: "2026-08-20T10:02:00.000Z",
    failureCode: eventType === "recurring_agreement_failed" ? "setup_declined" : undefined };
}

beforeEach(async () => {
  useInMemoryDb();
  mandateValid = true;
  disableAutoRenewal.mockClear();
  enableAutoRenewal.mockClear();
  process.env.LEARNING_SESSION_SECRET = "bi004-test-secret-that-is-at-least-32-chars";
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,
    owning_team,registry_status) values(?,?,'Magical Math','Math','icon-abacus','learning','team','active')`)
    .run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("bi004-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = (await createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "40000000-0000-4000-8000-000000000001" }, "2026-08-10")).learner.id;
  productId = (await defineProductVersion({ id: "product-bi004", slug: "bi004-monthly", name: "Math Monthly",
    subdomain: "math.example.test", planReference: "plan-bi004", priceInr: 299,
    productType: "individual_app", version: 1, appIds: [APP_ID] })).id;
});

describe("BI-004 cancel at period end", () => {
  it("AT-BI-004-01/02/03/05/06 authorizes the purchaser and schedules only the paid-period end", async () => {
    const subscriptionId = await activate();
    const before = row(subscriptionId);
    const foreign = (await sqliteAuthAdapter.signUp("bi004-foreign@example.com", "CorrectHorse1!")).user.id;
    await expect(cancelSubscriptionAtPeriodEnd(foreign, subscriptionId,
      { expectedVersion: before.version, idempotencyKey: "foreign" }, { now: CANCEL_AT, adapter: provider })).rejects.toThrow(new BillingAssignmentError("RESOURCE_NOT_FOUND"));
    const result = await cancel(subscriptionId);
    const after = row(subscriptionId);
    expect(result).toMatchObject({ autoRenewEnabled: false, cancelAtPeriodEnd: true,
      cancellationEffectiveAt: before.current_period_end, progressPreserved: true });
    expect(after).toMatchObject({ status: "active", auto_renew_enabled: 0, cancel_at_period_end: 1,
      cancellation_effective_at: before.current_period_end, cancellation_reason_code: "self_service" });
    expect(disableAutoRenewal).toHaveBeenCalledOnce();
  });

  it("AT-BI-004-07..10/17 preserves the paid period, access and credits and creates no grace/allocation", async () => {
    const subscriptionId = await activate();
    const before = row(subscriptionId);
    const periods = (getDb().prepare("select count(*) n from billing_periods where subscription_id=?")
      .get(subscriptionId) as any).n;
    const batches = (getDb().prepare("select count(*) n from learner_app_standard_credit_batches")
      .get() as any).n;
    await cancel(subscriptionId);
    expect(await evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "test", useCase: "start",
      now: new Date("2026-09-01T10:00:00.000Z") })).toMatchObject({ allowed: true, state: "active" });
    const after = row(subscriptionId);
    expect([after.current_period_start, after.current_period_end, after.billing_anchor_at])
      .toEqual([before.current_period_start, before.current_period_end, before.billing_anchor_at]);
    expect(after.grace_ends_at).toBeNull();
    expect((getDb().prepare("select count(*) n from billing_periods where subscription_id=?")
      .get(subscriptionId) as any).n).toBe(periods);
    expect((getDb().prepare("select count(*) n from learner_app_standard_credit_batches")
      .get() as any).n).toBe(batches);
  });

  it("AT-BI-004-18/19/31 emits one safe invoice-email confirmation and exact retries return it", async () => {
    const subscriptionId = await activate();
    const version = row(subscriptionId).version;
    const input = { expectedVersion: version, idempotencyKey: "cancel-exact" };
    const first = await cancelSubscriptionAtPeriodEnd(parentId, subscriptionId, input, { now: CANCEL_AT, adapter: provider });
    expect(await cancelSubscriptionAtPeriodEnd(parentId, subscriptionId, input, { now: CANCEL_AT, adapter: provider }))
      .toEqual(first);
    const notification = getDb().prepare(
      "select * from billing_cancellation_notifications where subscription_id=? and notification_type='scheduled'",
    ).get(subscriptionId) as any;
    expect(notification.recipient_email).toBe("bi004-parent@example.com");
    expect(JSON.parse(notification.safe_context_json)).toMatchObject({ learnerName: "Asha",
      productName: "Math Monthly", cancellationEffectiveAt: row(subscriptionId).current_period_end });
    expect((getDb().prepare("select count(*) n from billing_cancellation_notifications where subscription_id=?")
      .get(subscriptionId) as any).n).toBe(1);
  });

  it("AT-BI-004-31..33 rejects conflicting retries and stale versions without partial changes", async () => {
    const subscriptionId = await activate();
    const version = row(subscriptionId).version;
    await cancelSubscriptionAtPeriodEnd(parentId, subscriptionId,
      { expectedVersion: version, idempotencyKey: "shared-key" }, { now: CANCEL_AT, adapter: provider });
    await expect(resumeSubscriptionAutoRenewal(parentId, subscriptionId,
      { expectedVersion: row(subscriptionId).version, idempotencyKey: "shared-key" },
      { now: new Date("2026-08-20T10:00:00.000Z"), adapter: provider })).rejects.toThrow(new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED"));
    await expect(cancelSubscriptionAtPeriodEnd(parentId, subscriptionId,
      { expectedVersion: version, idempotencyKey: "stale" }, { now: CANCEL_AT, adapter: provider })).rejects.toThrow(new BillingAssignmentError("VERSION_CONFLICT"));
  });

  it("AT-BI-004-35 rolls back local cancellation when its atomic event/outbox transition fails", async () => {
    const subscriptionId = await activate();
    getDb().exec("drop table account_events");
    await expect(cancel(subscriptionId, "atomic")).rejects.toThrow();
    expect(row(subscriptionId)).toMatchObject({ auto_renew_enabled: 1, cancel_at_period_end: 0,
      cancellation_effective_at: null });
  });
});

describe("BI-004 deterministic period-end cutoff", () => {
  it("AT-BI-004-11/12/14/15/16 ends access, releases a starting reservation and preserves progress", async () => {
    const subscriptionId = await activate();
    await cancel(subscriptionId);
    getDb().prepare(
      `insert into learner_app_progress(learner_id,app_id,current_level_key,current_state_json,state_hash)
       values(?,?,'level-4','{"level":4}','safe-hash')`,
    ).run(learnerId, APP_ID);
    const started = await startLearnerSession({ actorSessionId: "parent-session", parentUserId: parentId,
      selectedLearnerId: learnerId, learnerId, appId: APP_ID, deviceSessionId: "device-1",
      scheduleAuthorizationId: "schedule-1", scheduleAuthorized: true, idempotencyKey: "start-before-end",
      now: new Date("2026-09-10T09:58:00.000Z"), fundingSource: "standard_monthly",
      deployment: { deploymentId: "deployment-1", releaseId: "release-1", environment: "test",
        origin: "https://math.example.test", launchPath: "/launch", compatibilityPassed: true,
        dispatchBlocked: false } });
    await expect(startLearnerSession({ actorSessionId: "parent-session-2", parentUserId: parentId,
      selectedLearnerId: learnerId, learnerId, appId: APP_ID, deviceSessionId: "device-2",
      scheduleAuthorizationId: "schedule-2", scheduleAuthorized: true, idempotencyKey: "start-after-end",
      now: new Date("2026-09-10T10:00:00.000Z"), fundingSource: "standard_monthly",
      deployment: { deploymentId: "deployment-1", releaseId: "release-1", environment: "test",
        origin: "https://math.example.test", launchPath: "/launch", compatibilityPassed: true,
        dispatchBlocked: false } })).rejects.toThrow(new LearnerSessionError("ENTITLEMENT_INACTIVE"));
    expect(row(subscriptionId)).toMatchObject({ status: "cancelled", payment_state: "paid" });
    expect(getDb().prepare("select status,funding_state,end_reason from learner_sessions where id=?")
      .get((started as any).sessionId)).toEqual({ status: "cancelled_before_launch", funding_state: "released",
      end_reason: "subscription_cancelled" });
    expect(getDb().prepare("select current_level_key,current_state_json from learner_app_progress where learner_id=? and app_id=?")
      .get(learnerId, APP_ID)).toEqual({ current_level_key: "level-4", current_state_json: "{\"level\":4}" });
  });

  it("AT-BI-004-13 keeps an established session bounded by its original hard expiry", async () => {
    const subscriptionId = await activate(); await cancel(subscriptionId);
    const started = await startLearnerSession({ actorSessionId: "active-parent-session", parentUserId: parentId,
      selectedLearnerId: learnerId, learnerId, appId: APP_ID, deviceSessionId: "active-device",
      scheduleAuthorizationId: "active-schedule", scheduleAuthorized: true, idempotencyKey: "active-start",
      now: new Date("2026-09-10T09:50:00.000Z"), fundingSource: "standard_monthly",
      deployment: { deploymentId: "deployment-1", releaseId: "release-1", environment: "test",
        origin: "https://math.example.test", launchPath: "/launch", compatibilityPassed: true,
        dispatchBlocked: false } }) as any;
    const hardExpiry = "2026-09-10T10:50:00.000Z";
    getDb().prepare(
      `update learner_sessions set status='active',funding_state='consumed',usable_launch_established_at=?,
       hard_expires_at=?,active_segment_started_at=?,version=version+1 where id=?`,
    ).run("2026-09-10T09:50:00.000Z", hardExpiry, "2026-09-10T09:50:00.000Z", started.sessionId);
    const session = getDb().prepare("select * from learner_sessions where id=?").get(started.sessionId) as any;
    const decision = await evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "test", useCase: "resume",
      boundEffectiveEntitlementId: session.effective_entitlement_id,
      now: new Date("2026-09-10T10:01:00.000Z") });
    expect(decision.allowed).toBe(true);
    expect(getDb().prepare("select status,hard_expires_at from learner_sessions where id=?")
      .get(started.sessionId)).toEqual({ status: "active", hard_expires_at: hardExpiry });
  });
});

describe("BI-004 cancellation reversal", () => {
  it("AT-BI-004-20..22/27/28 reuses a valid mandate without charging or changing bindings/credits", async () => {
    const subscriptionId = await activate(); await cancel(subscriptionId);
    const before = row(subscriptionId);
    const batches = getDb().prepare(
      "select id,granted_count,expires_at from learner_app_standard_credit_batches order by id",
    ).all();
    const periods = (getDb().prepare("select count(*) n from billing_periods where subscription_id=?")
      .get(subscriptionId) as any).n;
    const result = await resume(subscriptionId);
    const after = row(subscriptionId);
    expect(result).toMatchObject({ autoRenewEnabled: true, cancelAtPeriodEnd: false,
      providerHostedSetupRequired: false, nextChargeAt: before.current_period_end });
    expect([after.purchaser_parent_id, after.assigned_learner_id, after.product_id,
      after.billing_price_id, after.current_period_end, after.billing_anchor_at])
      .toEqual([before.purchaser_parent_id, before.assigned_learner_id, before.product_id,
        before.billing_price_id, before.current_period_end, before.billing_anchor_at]);
    expect(after).toMatchObject({ cancellation_requested_at: null, cancellation_effective_at: null,
      auto_renew_enabled: 1, cancel_at_period_end: 0, provider_mandate_status: "valid" });
    expect(enableAutoRenewal).toHaveBeenCalledOnce();
    expect((getDb().prepare("select count(*) n from billing_periods where subscription_id=?")
      .get(subscriptionId) as any).n).toBe(periods);
    expect(getDb().prepare("select id,granted_count,expires_at from learner_app_standard_credit_batches order by id").all())
      .toEqual(batches);
  });

  it("AT-BI-004-23/24 requires hosted setup for an invalid mandate and restores only on verified confirmation", async () => {
    const subscriptionId = await activate(); await cancel(subscriptionId);
    mandateValid = false;
    const pending = await resume(subscriptionId, "setup-resume") as any;
    expect(pending).toMatchObject({ providerHostedSetupRequired: true, autoRenewEnabled: false,
      cancelAtPeriodEnd: true });
    expect(row(subscriptionId)).toMatchObject({ auto_renew_enabled: 0, cancel_at_period_end: 1,
      provider_mandate_status: "pending_setup" });
    const event = setupEvent(subscriptionId, "recurring_agreement_confirmed");
    const first = await processVerifiedRecurringAgreementEvent(event, new Date("2026-08-20T10:03:00.000Z"));
    expect(await processVerifiedRecurringAgreementEvent(event, new Date("2026-08-20T10:04:00.000Z"))).toEqual(first);
    expect(row(subscriptionId)).toMatchObject({ auto_renew_enabled: 1, cancel_at_period_end: 0,
      provider_mandate_status: "valid", provider_mandate_ref: "new-mandate:1" });
  });

  it("AT-BI-004-25 leaves cancellation active when hosted mandate setup fails", async () => {
    const subscriptionId = await activate(); await cancel(subscriptionId);
    mandateValid = false; await resume(subscriptionId, "failed-setup");
    await processVerifiedRecurringAgreementEvent(setupEvent(subscriptionId, "recurring_agreement_failed", "failed"),
      new Date("2026-08-20T10:03:00.000Z"));
    expect(row(subscriptionId)).toMatchObject({ auto_renew_enabled: 0, cancel_at_period_end: 1,
      provider_mandate_status: "invalid" });
    expect((getDb().prepare("select status from recurring_agreement_setup_sessions where subscription_id=?")
      .get(subscriptionId) as any).status).toBe("failed");

    learnerId = (await createLearner(parentId, { displayName: "Ravi", dateOfBirth: "2017-05-12",
      idempotencyKey: "40000000-0000-4000-8000-000000000003" }, "2026-08-10")).learner.id;
    const expiring = await activate("expiring-setup"); await cancel(expiring, "expiring-cancel");
    mandateValid = false;
    const pending = await resume(expiring, "expiring-resume", new Date("2026-08-20T10:00:00.000Z"));
    await getCancellationBillingStatus(parentId, expiring, new Date(pending.setupExpiresAt));
    expect(row(expiring)).toMatchObject({ auto_renew_enabled: 0, cancel_at_period_end: 1,
      provider_mandate_status: "invalid" });
    expect((getDb().prepare("select status from recurring_agreement_setup_sessions where subscription_id=?")
      .get(expiring) as any).status).toBe("expired");
  });

  it("AT-BI-004-26 denies reversal at the exact period end and ends without BI-003 grace", async () => {
    const subscriptionId = await activate(); await cancel(subscriptionId);
    const end = row(subscriptionId).current_period_end;
    await expect(resume(subscriptionId, "too-late", new Date(end))).rejects.toThrow(new BillingAssignmentError("CANCELLATION_REVERSAL_WINDOW_EXPIRED"));
    expect(row(subscriptionId)).toMatchObject({ status: "cancelled", payment_state: "paid",
      grace_started_at: null, grace_ends_at: null });
  });

  it("AT-BI-004-29/30 preserves one T-7 reminder early and uses exact charge confirmation late", async () => {
    const early = await activate("early"); await cancel(early, "early-cancel");
    const earlyResult = await resume(early, "early-resume", new Date("2026-08-20T10:00:00.000Z"));
    expect(earlyResult).toMatchObject({ reminderScheduled: true,
      nextChargeAt: "2026-09-10T10:00:00.000Z", expectedAmount: 29900, currency: "INR" });
    expect(getDb().prepare(
      "select reminder_due_at,status from subscription_renewal_reminders where subscription_id=?",
    ).get(early)).toEqual({ reminder_due_at: "2026-09-03T10:00:00.000Z", status: "pending" });

    learnerId = (await createLearner(parentId, { displayName: "Ravi", dateOfBirth: "2017-05-12",
      idempotencyKey: "40000000-0000-4000-8000-000000000002" }, "2026-08-10")).learner.id;
    const late = await activate("late"); await cancel(late, "late-cancel", new Date("2026-09-05T10:00:00.000Z"));
    const lateResult = await resume(late, "late-resume", new Date("2026-09-05T10:01:00.000Z"));
    expect(lateResult).toMatchObject({ reminderScheduled: false, lateConfirmationRequired: true,
      nextChargeAt: "2026-09-10T10:00:00.000Z", expectedAmount: 29900, currency: "INR" });
    expect((getDb().prepare(
      "select count(*) n from subscription_renewal_reminders where subscription_id=? and status in ('pending','retry_pending')",
    ).get(late) as any).n).toBe(0);
  });

  it("AT-BI-004-32/34 exposes no app billing repository or pause/immediate-termination state", async () => {
    expect(Object.keys(supabaseTableAccess)).toEqual(expect.arrayContaining([
      "recurring_agreement_setup_sessions", "billing_cancellation_notifications",
    ]));
    expect(Object.keys(repositoryScopeRegistry).some((path) => path.startsWith("apps/"))).toBe(false);
    const columns = getDb().prepare("pragma table_info(subscriptions)").all().map((item: any) => item.name);
    expect(columns).not.toEqual(expect.arrayContaining(["pause_at", "paused_until", "immediate_termination_at"]));
  });

  it("AT-BI-004-35 rolls back local reversal when atomic event/outbox work fails", async () => {
    const subscriptionId = await activate(); await cancel(subscriptionId);
    getDb().exec("drop table account_events");
    await expect(resume(subscriptionId, "atomic-resume")).rejects.toThrow();
    expect(row(subscriptionId)).toMatchObject({ auto_renew_enabled: 0, cancel_at_period_end: 1 });
  });

  it("API-BI-009 exposes only safe cancellation, mandate and next-charge state", async () => {
    const subscriptionId = await activate(); await cancel(subscriptionId);
    expect(await getCancellationBillingStatus(parentId, subscriptionId, CANCEL_AT)).toEqual({
      cancellationEffectiveAt: "2026-09-10T10:00:00.000Z", canResumeAutoRenew: true,
      providerMandateStatus: "valid", nextChargeAt: null,
    });
    await expect(getCancellationBillingStatus("foreign-parent", subscriptionId, CANCEL_AT)).rejects.toThrow(new BillingAssignmentError("RESOURCE_NOT_FOUND"));
  });
});
