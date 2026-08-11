import { generateKeyPairSync, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { processVerifiedPaymentEvent } from "@/lib/billing/bi002-service";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter } from "@/lib/billing/provider-adapter";
import { createPlatformServiceAssertion } from "@/lib/authorization/internal-decision";
import { POST as reconcileIntegrityRoute } from "@/app/v1/internal/entitlements/reconcile-integrity/route";
import { POST as reconcilePaidCycleRoute } from "@/app/v1/internal/entitlements/reconcile-paid-cycle/[paidCycleId]/route";
import { POST as reconcileLearnerAppRoute } from "@/app/v1/internal/entitlements/reconcile-learner-app/route";

const APP_ID = "app-en004-routes";
const ACCOUNT_ID = "acct-en004-routes";
const now = new Date();
const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
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

function activate(key: string) {
  const view = getProductPurchaseView(productId);
  const created = createCheckoutIntent(parentId, { learnerId, productId, productVersion: view.version,
    priceId: view.price.id, priceVersion: view.price.version, autoRenewEnabled: true,
    consentDisclosureVersion: BILLING_CONSENT_DISCLOSURE_VERSION, idempotencyKey: key },
  { now: new Date("2026-08-10T09:59:00.000Z"), provider });
  const intent = getDb().prepare("select * from checkout_intents where id=?").get(created.checkoutIntentId) as any;
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(intent.subscription_id) as any;
  const result = processVerifiedPaymentEvent({ provider: intent.provider, environment: intent.provider_environment,
    accountId: intent.provider_account_id, providerEventId: `activation:${key}`,
    eventType: "initial_payment_succeeded", checkoutIntentId: intent.id,
    providerCheckoutRef: intent.provider_checkout_ref, providerPaymentRef: `initial-payment:${key}`,
    providerSubscriptionRef: subscription.provider_subscription_ref, providerMandateRef: intent.provider_mandate_ref,
    amount: intent.amount, currency: intent.currency, priceId: intent.price_id, priceVersion: intent.price_version,
    settledAt: "2026-08-10T10:00:00.000Z" }, new Date("2026-08-10T10:01:00.000Z")) as any;
  return { subscriptionId: result.subscriptionId as string, billingPeriodId: result.billingPeriodId as string };
}

function subscriptionVersion(subscriptionId: string): number {
  return (getDb().prepare("select version from subscriptions where id=?").get(subscriptionId) as { version: number }).version;
}

function serviceRequest(url: string, body: unknown, jti = `req-${randomUUID()}`) {
  const assertion = createPlatformServiceAssertion({ serviceKey: "entitlement-integrity-monitor-service",
    audience: "babysteps:internal:entitlements:reconcile_integrity", jti, now, privateKeyPem });
  return new Request(url, { method: "POST",
    headers: { "x-babysteps-service-assertion": assertion, "content-type": "application/json" },
    body: JSON.stringify(body) });
}

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,
    owning_team,registry_status) values(?,?,'Math App','Math','icon-abacus','learning','team','active')`)
    .run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("en004-routes-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "a0000000-0000-4000-8000-000000000005" }, "2026-08-10").learner.id;
  productId = defineProductVersion({ id: "product-en004-routes", slug: "en004-routes-monthly",
    name: "Math Monthly", subdomain: "en004routes.example.test", planReference: "plan-en004routes",
    priceInr: 299, productType: "individual_app", version: 1, appIds: [APP_ID] }).id;
  getDb().prepare(`insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
    values('integrity-monitor-id','entitlement-integrity-monitor-service','integrity-ref',?,'active','2020-01-01T00:00:00Z','2035-01-01T00:00:00Z',1)`)
    .run(keys.publicKey.export({ type: "spki", format: "pem" }).toString());
});

describe("POST /v1/internal/entitlements/reconcile-integrity", () => {
  it("rejects a request with no service assertion", async () => {
    const response = await reconcileIntegrityRoute(
      new Request("http://localhost/v1/internal/entitlements/reconcile-integrity", { method: "POST" }));
    expect(response.status).toBe(401);
  });

  it("runs a bounded sweep and reports counts", async () => {
    activate("route-sweep-1");
    const response = await reconcileIntegrityRoute(serviceRequest(
      "http://localhost/v1/internal/entitlements/reconcile-integrity",
      { environment: "test", limit: 50, runIdempotencyKey: "route-sweep-run-1" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ processed: 1, healthyCount: 1 });
  });

  it("rejects a malformed body", async () => {
    const response = await reconcileIntegrityRoute(serviceRequest(
      "http://localhost/v1/internal/entitlements/reconcile-integrity", { environment: "test" }));
    expect(response.status).toBe(400);
  });
});

describe("POST /v1/internal/entitlements/reconcile-paid-cycle/[paidCycleId]", () => {
  it("repairs a missing entitlement cycle", async () => {
    const { subscriptionId, billingPeriodId } = activate("route-repair-1");
    getDb().prepare("update learner_app_entitlement_periods set standard_credit_batch_id=null,effective_entitlement_id=null where learner_id=?").run(learnerId);
    getDb().prepare("delete from learner_app_effective_sources where effective_entitlement_id in " +
      "(select id from learner_app_effective_entitlements where learner_id=?)").run(learnerId);
    getDb().prepare("delete from learner_app_effective_entitlements where learner_id=?").run(learnerId);
    getDb().prepare("delete from learner_app_standard_credit_batches where learner_id=?").run(learnerId);
    getDb().prepare("delete from learner_app_entitlement_periods where learner_id=?").run(learnerId);
    getDb().prepare("delete from entitlement_cycles where paid_cycle_id=?").run(billingPeriodId);
    getDb().prepare("delete from entitlement_application_receipts where paid_cycle_id=?").run(billingPeriodId);

    const response = await reconcilePaidCycleRoute(serviceRequest(
      `http://localhost/v1/internal/entitlements/reconcile-paid-cycle/${billingPeriodId}`,
      { expectedSourceVersion: subscriptionVersion(subscriptionId), runIdempotencyKey: "route-repair-run-1" }),
      { params: { paidCycleId: billingPeriodId } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ action: "repair", category: "MISSING_ENTITLEMENT" });
  });

  it("maps a domain error to its HTTP status", async () => {
    const response = await reconcilePaidCycleRoute(serviceRequest(
      "http://localhost/v1/internal/entitlements/reconcile-paid-cycle/nonexistent",
      { expectedSourceVersion: 1, runIdempotencyKey: "route-missing-1" }),
      { params: { paidCycleId: "nonexistent" } });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("RESOURCE_NOT_FOUND");
  });
});

describe("POST /v1/internal/entitlements/reconcile-learner-app", () => {
  it("is a healthy no-op for a consistent learner+app", async () => {
    activate("route-la-1");
    const effective = getDb().prepare("select effective_version from learner_app_effective_entitlements where learner_id=? and app_id=?")
      .get(learnerId, APP_ID) as { effective_version: number };
    const response = await reconcileLearnerAppRoute(serviceRequest(
      "http://localhost/v1/internal/entitlements/reconcile-learner-app",
      { learnerId, appId: APP_ID, environment: "test", expectedSourceVersion: effective.effective_version,
        runIdempotencyKey: "route-la-run-1" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ action: "healthy" });
  });

  it("rejects a malformed body", async () => {
    const response = await reconcileLearnerAppRoute(serviceRequest(
      "http://localhost/v1/internal/entitlements/reconcile-learner-app", { learnerId }));
    expect(response.status).toBe(400);
  });
});
