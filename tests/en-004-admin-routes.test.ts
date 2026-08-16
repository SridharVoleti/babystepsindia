import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimitsForTests } from "@/lib/auth/rate-limit";

const mocks = vi.hoisted(() => ({
  requireAdminApi: vi.fn<() => Promise<{ ok: true; session: { sub: string; email: string }; principal: object } |
    { ok: false; response: unknown }>>(async () => ({
    ok: true, session: { sub: "admin-1", email: "admin@example.com" }, principal: {},
  })),
  requireReauth: vi.fn<() => Response | null>(() => null),
  checkRateLimit: vi.fn(() => true),
}));

vi.mock("@/lib/auth/admin-api-guard", () => ({
  requireAdminApi: mocks.requireAdminApi,
  requireReauth: mocks.requireReauth,
}));
vi.mock("@/lib/auth/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/rate-limit")>();
  return { ...actual, checkRateLimit: mocks.checkRateLimit };
});

import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { processVerifiedPaymentEvent } from "@/lib/billing/bi002-service";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter } from "@/lib/billing/provider-adapter";
import { reconcilePaidCycle } from "@/lib/entitlement-integrity/repair";
import { EntitlementIntegrityError } from "@/lib/entitlement-integrity/errors";
import { GET as getIncidentRoute } from "@/app/v1/admin/entitlement-integrity-incidents/[incidentId]/route";
import { POST as postIncidentActionRoute } from "@/app/v1/admin/entitlement-integrity-incidents/[incidentId]/action/route";
import { ensureBootstrapPlatformAdmin } from "./helpers/staff-session-fixture";

const APP_ID = "app-en004-admin-routes";
const ACCOUNT_ID = "acct-en004-admin-routes";
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

function makeConflictIncident(key: string) {
  const { subscriptionId, billingPeriodId } = activate(key);
  getDb().prepare("update entitlement_cycles set product_version=2 where paid_cycle_id=?").run(billingPeriodId);
  expect(() => reconcilePaidCycle({ paidCycleId: billingPeriodId, expectedSourceVersion: subscriptionVersion(subscriptionId),
    principalId: "integrity-monitor", runIdempotencyKey: `${key}-first`, now: new Date("2026-08-20T00:00:00.000Z") }))
    .toThrow(EntitlementIntegrityError);
  const incident = getDb().prepare("select id,version from entitlement_integrity_incidents where source_id=?")
    .get(billingPeriodId) as { id: string; version: number };
  return incident;
}

function actionRequest(body: unknown) {
  return new Request("https://platform.example/v1/admin/entitlement-integrity-incidents/incident-1/action", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetRateLimitsForTests();
  mocks.requireReauth.mockReturnValue(null);
  mocks.checkRateLimit.mockReturnValue(true);
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,
    owning_team,registry_status) values(?,?,'Math App','Math','icon-abacus','learning','team','active')`)
    .run(APP_ID, APP_ID);
  const adminId = ensureBootstrapPlatformAdmin();
  mocks.requireAdminApi.mockResolvedValue({ ok: true, session: { sub: adminId, email: "admin@example.com" }, principal: {} });
  parentId = (await sqliteAuthAdapter.signUp("en004-admin-routes-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "a0000000-0000-4000-8000-000000000006" }, "2026-08-10").learner.id;
  productId = defineProductVersion({ id: "product-en004-admin-routes", slug: "en004-admin-routes-monthly",
    name: "Math Monthly", subdomain: "en004adminroutes.example.test", planReference: "plan-en004adminroutes",
    priceInr: 299, productType: "individual_app", version: 1, appIds: [APP_ID] }).id;
});

describe("GET /v1/admin/entitlement-integrity-incidents/[incidentId]", () => {
  it("returns the safe incident view for an admin with the exact permission", async () => {
    const incident = makeConflictIncident("admin-route-get-1");
    const response = await getIncidentRoute(new Request("http://localhost"), { params: { incidentId: incident.id } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.category).toBe("PRODUCT_SNAPSHOT_MISMATCH");
    expect(body.status).toBe("open");
  });

  it("returns 404 for an unknown incident", async () => {
    const response = await getIncidentRoute(new Request("http://localhost"), { params: { incidentId: "missing" } });
    expect(response.status).toBe(404);
  });

  it("returns the guard's response when the admin lacks the permission", async () => {
    mocks.requireAdminApi.mockResolvedValueOnce({ ok: false, response: Response.json({ error: "FORBIDDEN" }, { status: 403 }) });
    const incident = makeConflictIncident("admin-route-get-2");
    const response = await getIncidentRoute(new Request("http://localhost"), { params: { incidentId: incident.id } });
    expect(response.status).toBe(403);
  });
});

describe("POST /v1/admin/entitlement-integrity-incidents/[incidentId]/action", () => {
  it("requires reauthentication before acting", async () => {
    mocks.requireReauth.mockReturnValueOnce(Response.json({ error: "REAUTHENTICATION_REQUIRED" }, { status: 401 }));
    const incident = makeConflictIncident("admin-route-action-1");
    const response = await postIncidentActionRoute(actionRequest({ currentPassword: "wrong",
      action: "resolve_false_positive", expectedVersion: incident.version, idempotencyKey: "k1",
      reasonCategory: "known_false_positive" }), { params: { incidentId: incident.id } });
    expect(response.status).toBe(401);
  });

  it("rejects an unrecognized action", async () => {
    const incident = makeConflictIncident("admin-route-action-2");
    const response = await postIncidentActionRoute(actionRequest({ currentPassword: "correct",
      action: "manual_grant", expectedVersion: incident.version, idempotencyKey: "k2" }),
      { params: { incidentId: incident.id } });
    expect(response.status).toBe(400);
  });

  it("requires expectedVersion and idempotencyKey", async () => {
    const incident = makeConflictIncident("admin-route-action-3");
    const response = await postIncidentActionRoute(actionRequest({ currentPassword: "correct",
      action: "resolve_false_positive", reasonCategory: "known_false_positive" }),
      { params: { incidentId: incident.id } });
    expect(response.status).toBe(400);
  });

  it("resolves a false positive end to end", async () => {
    const incident = makeConflictIncident("admin-route-action-4");
    const response = await postIncidentActionRoute(actionRequest({ currentPassword: "correct",
      action: "resolve_false_positive", expectedVersion: incident.version, idempotencyKey: "k4",
      reasonCategory: "known_false_positive" }), { params: { incidentId: incident.id } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ result: "applied", incidentStatus: "resolved_false_positive" });
  });

  it("maps a version conflict to 409", async () => {
    const incident = makeConflictIncident("admin-route-action-5");
    const response = await postIncidentActionRoute(actionRequest({ currentPassword: "correct",
      action: "resolve_false_positive", expectedVersion: incident.version + 1, idempotencyKey: "k5",
      reasonCategory: "known_false_positive" }), { params: { incidentId: incident.id } });
    expect(response.status).toBe(409);
  });
});
