// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { processVerifiedPaymentEvent } from "@/lib/billing/bi002-service";
import { confirmProviderRefund, createRefundCase } from "@/lib/billing/bi005-service";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter, VerifiedProviderPaymentEvent } from "@/lib/billing/provider-adapter";

const APP_ID = "app-nt001-bi005-math";
const ACCOUNT_ID = "acct-nt001-bi005";
let parentId: string;
let learnerId: string;
let productId: string;

const confirmRefund = vi.fn(() => ({ confirmed: true as const, providerRefundRef: "provider-refund-1",
  refundConfirmedAt: "2026-08-20T10:00:00.000Z" }));
const provider: BillingCheckoutProviderAdapter = {
  createCheckout(input) { return { provider: "contract-provider", environment: "test", accountId: ACCOUNT_ID,
    providerCheckoutRef: `checkout:${input.checkoutIntentId}`,
    providerSubscriptionRef: `provider-sub:${input.checkoutIntentId}`,
    providerMandateRef: `mandate:${input.checkoutIntentId}`,
    handoff: { url: `/provider/${input.checkoutIntentId}`, method: "GET" } }; },
  confirmRefund,
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
  const event: VerifiedProviderPaymentEvent = { provider: intent.provider,
    environment: intent.provider_environment, accountId: intent.provider_account_id,
    providerEventId: `activation:${key}`, eventType: "initial_payment_succeeded",
    checkoutIntentId: intent.id, providerCheckoutRef: intent.provider_checkout_ref,
    providerPaymentRef: `payment:${key}`, providerSubscriptionRef: subscription.provider_subscription_ref,
    providerMandateRef: intent.provider_mandate_ref, amount: intent.amount, currency: intent.currency,
    priceId: intent.price_id, priceVersion: intent.price_version, settledAt: "2026-08-10T10:00:00.000Z" };
  return (processVerifiedPaymentEvent(event, new Date("2026-08-10T10:01:00.000Z")) as any).subscriptionId as string;
}

beforeEach(async () => {
  useInMemoryDb();
  confirmRefund.mockClear();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,
    owning_team,registry_status) values(?,?,'Math App','Math','icon-abacus','learning','team','active')`)
    .run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("nt001-bi005-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "60000000-0000-4000-8000-000000000001" }, "2026-08-10").learner.id;
  productId = defineProductVersion({ id: "product-nt001-bi005", slug: "nt001-bi005-monthly", name: "Math Monthly",
    subdomain: "nt001bi005.example.test", planReference: "plan-nt001-bi005", priceInr: 299,
    productType: "individual_app", version: 1, appIds: [APP_ID] }).id;
});

describe("NT-001 real wiring: BI-005 refund outcome (AT-NT-001-20)", () => {
  it("AT-NT-001-20: a confirmed full refund enqueues exactly one billing_refund_outcome notification", () => {
    const subscriptionId = activate();
    const created = createRefundCase(parentId, { subscriptionId, refundType: "full", reasonCategory: "customer_request" });
    confirmProviderRefund(parentId, created.refundCaseId,
      { expectedVersion: created.version, idempotencyKey: "nt001-confirm-1" },
      { now: new Date("2026-08-20T10:00:00.000Z"), adapter: provider });
    const intents = getDb().prepare(
      "select * from transactional_notification_intents where source_event_key=?",
    ).all(`refund:${created.refundCaseId}`) as any[];
    expect(intents).toHaveLength(1);
    expect(intents[0].notification_type).toBe("billing_refund_outcome");
    expect(intents[0].parent_id).toBe(parentId);
    expect(JSON.parse(intents[0].safe_variables)).toMatchObject({ subscriptionLabel: "Math Monthly", refundType: "full" });
  });
});
