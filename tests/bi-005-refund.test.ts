import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { processVerifiedPaymentEvent } from "@/lib/billing/bi002-service";
import { createRefundCase, confirmProviderRefund, getRefundCase } from "@/lib/billing/bi005-service";
import { BillingAssignmentError } from "@/lib/billing/errors";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter, VerifiedProviderPaymentEvent } from "@/lib/billing/provider-adapter";
import { evaluateAccessFresh } from "@/lib/entitlement-access/service";

const APP_ID = "app-bi005-math";
const ACCOUNT_ID = "acct-bi005";
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
  parentId = (await sqliteAuthAdapter.signUp("bi005-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "60000000-0000-4000-8000-000000000001" }, "2026-08-10").learner.id;
  productId = defineProductVersion({ id: "product-bi005", slug: "bi005-monthly", name: "Math Monthly",
    subdomain: "bi005.example.test", planReference: "plan-bi005", priceInr: 299,
    productType: "individual_app", version: 1, appIds: [APP_ID] }).id;
});

describe("BI-005 refund case lifecycle", () => {
  it("rule 26: creating a refund case does not change access", () => {
    const subscriptionId = activate();
    const before = evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "test", useCase: "start",
      now: new Date("2026-08-15T10:00:00.000Z") });
    const created = createRefundCase(parentId, { subscriptionId, refundType: "full", reasonCategory: "customer_request" });
    expect(created.status).toBe("pending_provider_confirmation");
    const after = evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "test", useCase: "start",
      now: new Date("2026-08-15T10:00:01.000Z") });
    expect(after).toMatchObject({ allowed: before.allowed, state: before.state });
  });

  it("rules 28-35: a confirmed full refund blocks new access immediately and preserves progress", () => {
    const subscriptionId = activate();
    const created = createRefundCase(parentId, { subscriptionId, refundType: "full", reasonCategory: "customer_request" });
    const result = confirmProviderRefund(parentId, created.refundCaseId,
      { expectedVersion: created.version, idempotencyKey: "confirm-1" },
      { now: new Date("2026-08-20T10:00:00.000Z"), adapter: provider });
    expect(result.status).toBe("confirmed");
    expect(confirmRefund).toHaveBeenCalledOnce();
    const access = evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "test", useCase: "start",
      now: new Date("2026-08-20T10:00:01.000Z") });
    expect(access.allowed).toBe(false);
    const entitlement = getDb().prepare("select state from learner_app_effective_entitlements where learner_id=? and app_id=?")
      .get(learnerId, APP_ID) as any;
    expect(entitlement.state).toBe("inactive_refunded");
    const subscription = getDb().prepare("select status from subscriptions where id=?").get(subscriptionId) as any;
    expect(subscription.status).toBe("refunded");
  });

  it("rule 38: a partial refund with no_change leaves access unchanged", () => {
    const subscriptionId = activate();
    const created = createRefundCase(parentId, { subscriptionId, refundType: "partial", amount: 5000,
      entitlementEffect: "no_change", reasonCategory: "goodwill" });
    confirmProviderRefund(parentId, created.refundCaseId,
      { expectedVersion: created.version, idempotencyKey: "confirm-2" },
      { now: new Date("2026-08-20T10:00:00.000Z"), adapter: provider });
    const access = evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "test", useCase: "start",
      now: new Date("2026-08-20T10:00:01.000Z") });
    expect(access.allowed).toBe(true);
  });

  it("rule 37: a partial refund with terminate_now blocks new access like a full refund", () => {
    const subscriptionId = activate();
    const created = createRefundCase(parentId, { subscriptionId, refundType: "partial", amount: 5000,
      entitlementEffect: "terminate_now", reasonCategory: "goodwill" });
    confirmProviderRefund(parentId, created.refundCaseId,
      { expectedVersion: created.version, idempotencyKey: "confirm-3" },
      { now: new Date("2026-08-20T10:00:00.000Z"), adapter: provider });
    const access = evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "test", useCase: "start",
      now: new Date("2026-08-20T10:00:01.000Z") });
    expect(access.allowed).toBe(false);
  });

  it("rejects a full refund missing a version match", () => {
    const subscriptionId = activate();
    const created = createRefundCase(parentId, { subscriptionId, refundType: "full", reasonCategory: "customer_request" });
    expect(() => confirmProviderRefund(parentId, created.refundCaseId,
      { expectedVersion: created.version + 5, idempotencyKey: "confirm-4" },
      { now: new Date("2026-08-20T10:00:00.000Z"), adapter: provider }))
      .toThrow(new BillingAssignmentError("VERSION_CONFLICT"));
  });

  it("requires entitlementEffect for a partial refund", () => {
    const subscriptionId = activate();
    expect(() => createRefundCase(parentId, { subscriptionId, refundType: "partial", amount: 5000,
      reasonCategory: "goodwill" })).toThrow(new BillingAssignmentError("INVALID_REQUEST"));
  });

  it("round-trips through getRefundCase", () => {
    const subscriptionId = activate();
    const created = createRefundCase(parentId, { subscriptionId, refundType: "full", reasonCategory: "customer_request" });
    expect(getRefundCase(created.refundCaseId)).toEqual(created);
  });
});
