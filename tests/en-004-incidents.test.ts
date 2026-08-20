import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { processVerifiedPaymentEvent } from "@/lib/billing/bi002-service";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter } from "@/lib/billing/provider-adapter";
import { EntitlementIntegrityError } from "@/lib/entitlement-integrity/errors";
import { reconcilePaidCycle } from "@/lib/entitlement-integrity/repair";
import { getSafeIncident, applyIncidentAction } from "@/lib/entitlement-integrity/incidents";

const APP_ID = "app-en004-incidents";
const ACCOUNT_ID = "acct-en004-incidents";
let parentId: string;
let learnerId: string;
let productId: string;
let adminId: string;

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

function checkout(key: string) {
  const view = getProductPurchaseView(productId);
  return createCheckoutIntent(parentId, { learnerId, productId, productVersion: view.version,
    priceId: view.price.id, priceVersion: view.price.version, autoRenewEnabled: true,
    consentDisclosureVersion: BILLING_CONSENT_DISCLOSURE_VERSION, idempotencyKey: key },
  { now: new Date("2026-08-10T09:59:00.000Z"), provider });
}

function activate(key: string) {
  const created = checkout(key);
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

async function makeConflictIncident(key: string) {
  const { subscriptionId, billingPeriodId } = activate(key);
  getDb().prepare("update entitlement_cycles set product_version=2 where paid_cycle_id=?").run(billingPeriodId);
  await expect(reconcilePaidCycle({ paidCycleId: billingPeriodId, expectedSourceVersion: subscriptionVersion(subscriptionId),
    principalId: "integrity-monitor", runIdempotencyKey: `${key}-first`, now: new Date("2026-08-20T00:00:00.000Z") }))
    .rejects.toThrow(EntitlementIntegrityError);
  const incident = getDb().prepare("select id,version from entitlement_integrity_incidents where source_id=?")
    .get(billingPeriodId) as { id: string; version: number };
  return { incident, subscriptionId, billingPeriodId };
}

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,
    owning_team,registry_status) values(?,?,'Math App','Math','icon-abacus','learning','team','active')`)
    .run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("en004-incidents-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = (await createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "a0000000-0000-4000-8000-000000000003" }, "2026-08-10")).learner.id;
  productId = defineProductVersion({ id: "product-en004-incidents", slug: "en004-incidents-monthly",
    name: "Math Monthly", subdomain: "en004incidents.example.test", planReference: "plan-en004incidents",
    priceInr: 299, productType: "individual_app", version: 1, appIds: [APP_ID] }).id;
  adminId = (await sqliteAuthAdapter.signUp("en004-incidents-admin@example.com", "CorrectHorse1!")).user.id;
});

describe("getSafeIncident", () => {
  it("returns safe fields and allowed actions for an open incident", async () => {
    const { incident } = await makeConflictIncident("safe-view");
    const safe = await getSafeIncident(incident.id);
    expect(safe.category).toBe("PRODUCT_SNAPSHOT_MISMATCH");
    expect(safe.status).toBe("open");
    expect(safe.allowedActions).toEqual(["retry", "resolve_false_positive", "open_refund_case"]);
  });

  it("throws NOT_FOUND for a missing incident", async () => {
    await expect(getSafeIncident("nonexistent")).rejects.toThrow(EntitlementIntegrityError);
  });
});

describe("applyIncidentAction", () => {
  it("rejects a stale expectedVersion", async () => {
    const { incident } = await makeConflictIncident("stale-version");
    await expect(applyIncidentAction({ incidentId: incident.id, action: "resolve_false_positive",
      actorAdminId: adminId, expectedVersion: incident.version + 1, idempotencyKey: "act-1",
      reasonCategory: "known_false_positive", now: new Date("2026-08-21T00:00:00.000Z") }))
      .rejects.toThrow(EntitlementIntegrityError);
  });

  it("is idempotent on repeated identical calls and rejects a reused key with a different action", async () => {
    const { incident } = await makeConflictIncident("idempotent-action");
    const first = await applyIncidentAction({ incidentId: incident.id, action: "resolve_false_positive",
      actorAdminId: adminId, expectedVersion: incident.version, idempotencyKey: "act-2",
      reasonCategory: "known_false_positive", now: new Date("2026-08-21T00:00:00.000Z") });
    const replay = await applyIncidentAction({ incidentId: incident.id, action: "resolve_false_positive",
      actorAdminId: adminId, expectedVersion: incident.version, idempotencyKey: "act-2",
      reasonCategory: "known_false_positive", now: new Date("2026-08-21T00:00:01.000Z") });
    expect(replay).toEqual(first);
    await expect(applyIncidentAction({ incidentId: incident.id, action: "retry",
      actorAdminId: adminId, expectedVersion: incident.version, idempotencyKey: "act-2",
      now: new Date("2026-08-21T00:00:02.000Z") })).rejects.toThrow(EntitlementIntegrityError);
  });

  it("resolve_false_positive requires a reasonCategory", async () => {
    const { incident } = await makeConflictIncident("missing-reason");
    const result = await applyIncidentAction({ incidentId: incident.id, action: "resolve_false_positive",
      actorAdminId: adminId, expectedVersion: incident.version, idempotencyKey: "act-3",
      now: new Date("2026-08-21T00:00:00.000Z") });
    expect(result).toEqual({ incidentId: incident.id, action: "resolve_false_positive", result: "rejected",
      resultCode: "REASON_CATEGORY_REQUIRED", incidentStatus: "open" });
  });

  it("resolve_false_positive closes the incident when given a reason", async () => {
    const { incident } = await makeConflictIncident("resolve-fp");
    const result = await applyIncidentAction({ incidentId: incident.id, action: "resolve_false_positive",
      actorAdminId: adminId, expectedVersion: incident.version, idempotencyKey: "act-4",
      reasonCategory: "known_false_positive", now: new Date("2026-08-21T00:00:00.000Z") });
    expect(result).toEqual({ incidentId: incident.id, action: "resolve_false_positive", result: "applied",
      resultCode: "FALSE_POSITIVE_RESOLVED", incidentStatus: "resolved_false_positive" });
  });

  it("open_refund_case fails closed without a real refund_cases id", async () => {
    const { incident } = await makeConflictIncident("refund-missing");
    const result = await applyIncidentAction({ incidentId: incident.id, action: "open_refund_case",
      actorAdminId: adminId, expectedVersion: incident.version, idempotencyKey: "act-5",
      now: new Date("2026-08-21T00:00:00.000Z") });
    expect(result.result).toBe("rejected");
    expect(result.resultCode).toBe("REFUND_CASE_REQUIRED");
  });

  it("open_refund_case fails closed for a refundCaseId that doesn't exist", async () => {
    const { incident } = await makeConflictIncident("refund-not-found");
    const result = await applyIncidentAction({ incidentId: incident.id, action: "open_refund_case",
      actorAdminId: adminId, expectedVersion: incident.version, idempotencyKey: "act-6",
      refundCaseId: "nonexistent-refund-case", now: new Date("2026-08-21T00:00:00.000Z") });
    expect(result.result).toBe("rejected");
    expect(result.resultCode).toBe("REFUND_CASE_NOT_FOUND");
  });

  it("open_refund_case routes to an existing refund case", async () => {
    const { incident, subscriptionId } = await makeConflictIncident("refund-routed");
    const refundCaseId = "refund-case-en004-1";
    getDb().prepare(`insert into refund_cases(id,subscription_id,refund_type,reason_category,status,version,created_at,updated_at)
      values(?,?, 'full','integrity_incident','pending_provider_confirmation',1,?,?)`)
      .run(refundCaseId, subscriptionId, "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:00.000Z");

    const result = await applyIncidentAction({ incidentId: incident.id, action: "open_refund_case",
      actorAdminId: adminId, expectedVersion: incident.version, idempotencyKey: "act-7",
      refundCaseId, now: new Date("2026-08-21T00:00:00.000Z") });
    expect(result).toEqual({ incidentId: incident.id, action: "open_refund_case", result: "applied",
      resultCode: "ROUTED_REFUND_CASE", incidentStatus: "routed_refund_case" });
    const safe = await getSafeIncident(incident.id);
    expect(safe.remediationWorkflow).toBe("refund_case");
    expect(safe.remediationReference).toBe(refundCaseId);
  });

  it("retry resolves the incident once the underlying mismatch is fixed", async () => {
    const { incident, billingPeriodId } = await makeConflictIncident("retry-resolves");
    getDb().prepare("update entitlement_cycles set product_version=1 where paid_cycle_id=?").run(billingPeriodId);

    const result = await applyIncidentAction({ incidentId: incident.id, action: "retry",
      actorAdminId: adminId, expectedVersion: incident.version, idempotencyKey: "act-8",
      now: new Date("2026-08-21T00:00:00.000Z") });
    expect(result).toEqual({ incidentId: incident.id, action: "retry", result: "applied",
      resultCode: "RETRY_RESOLVED", incidentStatus: "resolved_repaired" });
  });

  it("retry stays open when the underlying mismatch is still present", async () => {
    const { incident } = await makeConflictIncident("retry-still-conflicting");
    const result = await applyIncidentAction({ incidentId: incident.id, action: "retry",
      actorAdminId: adminId, expectedVersion: incident.version, idempotencyKey: "act-9",
      now: new Date("2026-08-21T00:00:00.000Z") });
    expect(result).toEqual({ incidentId: incident.id, action: "retry", result: "no_op",
      resultCode: "RETRY_STILL_CONFLICTING", incidentStatus: "open" });
  });
});
