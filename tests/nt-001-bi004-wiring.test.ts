// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { processVerifiedPaymentEvent } from "@/lib/billing/bi002-service";
import { cancelSubscriptionAtPeriodEnd, resumeSubscriptionAutoRenewal } from "@/lib/billing/bi004-service";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter, VerifiedProviderPaymentEvent } from "@/lib/billing/provider-adapter";

const APP_ID = "app-nt001-bi004-math";
const ACCOUNT_ID = "acct-nt001-bi004";
const ACTIVATED_AT = "2026-08-10T10:00:00.000Z";
const CANCEL_AT = new Date("2026-08-15T10:00:00.000Z");
let parentId: string;
let learnerId: string;
let productId: string;

const disableAutoRenewal = vi.fn(() => ({ confirmed: true as const }));
const enableAutoRenewal = vi.fn(() => ({ confirmed: true as const }));
const provider: BillingCheckoutProviderAdapter = {
  createCheckout(input) { return { provider: "contract-provider", environment: "test", accountId: ACCOUNT_ID,
    providerCheckoutRef: `checkout:${input.checkoutIntentId}`,
    providerSubscriptionRef: `provider-sub:${input.checkoutIntentId}`,
    providerMandateRef: `mandate:${input.checkoutIntentId}`,
    handoff: { url: `/provider/${input.checkoutIntentId}`, method: "GET" } }; },
  disableAutoRenewal,
  getRecurringAgreementStatus() { return { status: "valid" as const }; },
  enableAutoRenewal,
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
  return ((await processVerifiedPaymentEvent(event, new Date("2026-08-10T10:01:00.000Z"))) as any).subscriptionId as string;
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

function intentsFor(sourceEventKeyPrefix: string) {
  return getDb().prepare(
    "select * from transactional_notification_intents where source_event_key like ? order by created_at",
  ).all(`${sourceEventKeyPrefix}%`) as any[];
}

beforeEach(async () => {
  useInMemoryDb();
  disableAutoRenewal.mockClear(); enableAutoRenewal.mockClear();
  process.env.LEARNING_SESSION_SECRET = "nt001-bi004-test-secret-that-is-at-least-32-chars";
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,
    owning_team,registry_status) values(?,?,'Magical Math','Math','icon-abacus','learning','team','active')`)
    .run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("nt001-bi004-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = (await createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "40000000-0000-4000-8000-000000000001" }, "2026-08-10")).learner.id;
  productId = (await defineProductVersion({ id: "product-nt001-bi004", slug: "nt001-bi004-monthly", name: "Math Monthly",
    subdomain: "math.example.test", planReference: "plan-nt001-bi004", priceInr: 299,
    productType: "individual_app", version: 1, appIds: [APP_ID] })).id;
});

describe("NT-001 real wiring: BI-004 (AT-NT-001-17/18)", () => {
  it("AT-NT-001-17: scheduling a cancellation enqueues exactly one subscription_cancellation_scheduled notification", async () => {
    const subscriptionId = await activate();
    await cancel(subscriptionId);
    const intents = intentsFor(`cancellation-scheduled:${subscriptionId}:`);
    expect(intents).toHaveLength(1);
    expect(intents[0].notification_type).toBe("subscription_cancellation_scheduled");
    expect(intents[0].parent_id).toBe(parentId);
    expect(JSON.parse(intents[0].safe_variables)).toMatchObject({ subscriptionLabel: "Math Monthly" });
  });

  it("a replayed cancellation request (same idempotency key + version) does not create a second scheduled notification", async () => {
    const subscriptionId = await activate();
    const expectedVersion = row(subscriptionId).version;
    const idempotencyKey = "cancel-replay";
    await cancelSubscriptionAtPeriodEnd(parentId, subscriptionId, { expectedVersion, idempotencyKey },
      { now: CANCEL_AT, adapter: provider });
    await cancelSubscriptionAtPeriodEnd(parentId, subscriptionId, { expectedVersion, idempotencyKey },
      { now: CANCEL_AT, adapter: provider });
    expect(intentsFor(`cancellation-scheduled:${subscriptionId}:`)).toHaveLength(1);
  });

  it("AT-NT-001-18: reversing a cancellation enqueues exactly one subscription_cancellation_reversed notification", async () => {
    const subscriptionId = await activate();
    await cancel(subscriptionId);
    await resume(subscriptionId);
    const intents = intentsFor(`cancellation-reversed:${subscriptionId}:`);
    expect(intents).toHaveLength(1);
    expect(intents[0].notification_type).toBe("subscription_cancellation_reversed");
    expect(intents[0].parent_id).toBe(parentId);
  });
});
