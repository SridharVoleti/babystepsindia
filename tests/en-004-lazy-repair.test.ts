import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { processVerifiedPaymentEvent } from "@/lib/billing/bi002-service";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter } from "@/lib/billing/provider-adapter";
import { attemptLazyRepair } from "@/lib/entitlement-integrity/lazy-repair";

const APP_ID = "app-en004-lazy";
const ACCOUNT_ID = "acct-en004-lazy";
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
  processVerifiedPaymentEvent({ provider: intent.provider, environment: intent.provider_environment,
    accountId: intent.provider_account_id, providerEventId: `activation:${key}`,
    eventType: "initial_payment_succeeded", checkoutIntentId: intent.id,
    providerCheckoutRef: intent.provider_checkout_ref, providerPaymentRef: `initial-payment:${key}`,
    providerSubscriptionRef: subscription.provider_subscription_ref, providerMandateRef: intent.provider_mandate_ref,
    amount: intent.amount, currency: intent.currency, priceId: intent.price_id, priceVersion: intent.price_version,
    settledAt: "2026-08-10T10:00:00.000Z" }, new Date("2026-08-10T10:01:00.000Z"));
}

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,
    owning_team,registry_status) values(?,?,'Math App','Math','icon-abacus','learning','team','active')`)
    .run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("en004-lazy-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = (await createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "a0000000-0000-4000-8000-000000000004" }, "2026-08-10")).learner.id;
  productId = defineProductVersion({ id: "product-en004-lazy", slug: "en004-lazy-monthly",
    name: "Math Monthly", subdomain: "en004lazy.example.test", planReference: "plan-en004lazy",
    priceInr: 299, productType: "individual_app", version: 1, appIds: [APP_ID] }).id;
});

describe("attemptLazyRepair", () => {
  it("AC36: fails closed with timedOut when already past its deadline", async () => {
    activate("lazy-timeout");
    const result = await attemptLazyRepair({ learnerId, appId: APP_ID, environment: "test", timeoutMs: -1,
      now: new Date("2026-08-21T00:00:00.000Z") });
    expect(result).toEqual({ attempted: false, repaired: false, timedOut: true });
  });

  it("is a healthy no-op when nothing needs repair", async () => {
    activate("lazy-healthy");
    const result = await attemptLazyRepair({ learnerId, appId: APP_ID, environment: "test", timeoutMs: 1000,
      now: new Date("2026-08-21T00:00:00.000Z") });
    expect(result).toEqual({ attempted: true, repaired: false, timedOut: false });
  });

  it("completes a bounded repair when a pending lifecycle event affects this app", async () => {
    activate("lazy-repair");
    const eventRowId = randomUUID();
    const nowIso = "2026-08-21T00:00:00.000Z";
    getDb().prepare(`insert into entitlement_lifecycle_events(id,source,event_id,event_type,source_version,effective_at,
      learner_id,app_ids_json,environment,reason_category,fraud_or_security_risk,payload_hash,status,received_at,created_at,updated_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?, 'pending',?,?,?)`)
      .run(eventRowId, "platform_security", randomUUID(), "security_revoked", 1, nowIso, learnerId,
        JSON.stringify([APP_ID]), null, "manual_admin_action", 1, "placeholder-hash", nowIso, nowIso, nowIso);

    const result = await attemptLazyRepair({ learnerId, appId: APP_ID, environment: "test", timeoutMs: 1000,
      now: new Date("2026-08-21T00:00:01.000Z") });
    expect(result).toEqual({ attempted: true, repaired: true, timedOut: false });
    const eventRow = getDb().prepare("select status from entitlement_lifecycle_events where id=?").get(eventRowId) as any;
    expect(eventRow.status).toBe("applied");
  });

  it("does not throw for a learner+app with no effective entitlement at all", async () => {
    const result = await attemptLazyRepair({ learnerId, appId: APP_ID, environment: "test", timeoutMs: 1000,
      now: new Date("2026-08-21T00:00:00.000Z") });
    expect(result.attempted).toBe(true);
    expect(result.timedOut).toBe(false);
  });
});
