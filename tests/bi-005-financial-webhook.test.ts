import { createHmac, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { defineProductVersion } from "@/lib/billing/bi001-service";
import { ingestFinancialEventWebhook } from "@/lib/billing/bi005-service";
import { BillingAssignmentError } from "@/lib/billing/errors";
import { evaluateAccessFresh } from "@/lib/entitlement-access/service";
import { applyPaidCycle } from "@/lib/entitlement-cycle/service";

const APP_ID = "app-bi005-webhook";
const SECRET = "financial-events-webhook-secret-at-least-32-chars";
let parentId: string;
let learnerId: string;
let subscriptionId: string;

function sign(timestampSeconds: number, rawBody: string) {
  return createHmac("sha256", SECRET).update(`${timestampSeconds}.${rawBody}`).digest("hex");
}

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,
    owning_team,registry_status) values(?,?,'Math App','Math','icon-abacus','learning','team','active')`)
    .run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("bi005-webhook-parent@example.com", "CorrectHorse1!")).user.id;
  learnerId = createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-02-10",
    idempotencyKey: "80000000-0000-4000-8000-000000000001" }, "2026-08-10").learner.id;
  const productId = defineProductVersion({ id: "product-bi005-wh", slug: "bi005-webhook-monthly",
    name: "Math Monthly", subdomain: "bi005wh.example.test", planReference: "plan-bi005wh", priceInr: 299,
    productType: "individual_app", version: 1, appIds: [APP_ID] }).id;
  subscriptionId = `sub-${randomUUID()}`;
  getDb().prepare(
    `insert into subscriptions(id,user_id,type,product_id,purchaser_parent_id,assigned_learner_id,product_version,
     razorpay_subscription_id,current_period_end) values(?,?,?,?,?,?,?,?,?)`,
  ).run(subscriptionId, parentId, "single", productId, parentId, learnerId, 1,
    `razorpay-${subscriptionId}`, "2026-09-01T00:00:00.000Z");
  applyPaidCycle({
    paidCycleId: `cycle-${randomUUID()}`, eventId: `event-${randomUUID()}`, eventVersion: 1,
    subscriptionId, purchaserParentId: parentId, assignedLearnerId: learnerId,
    productId: "product-1", productVersion: 1, appIds: [APP_ID],
    periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z",
    billingAnchor: "2026-08-01", environment: "production", now: new Date("2026-08-01T00:00:00.000Z"),
  });
});

describe("BI-005 financial event webhook", () => {
  it("rule 41: a verified chargeback immediately suspends access as suspended_financial", () => {
    const now = new Date("2026-08-15T10:00:00.000Z");
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const payload = JSON.stringify({ provider: "test-provider", eventId: "chargeback-1",
      eventType: "chargeback_confirmed", subscriptionId, occurredAt: now.toISOString(),
      reasonCategory: "payment_reversal" });
    const receipt = ingestFinancialEventWebhook({ provider: "test-provider", providerEventId: "chargeback-1",
      timestampSeconds, signatureHex: sign(timestampSeconds, payload), rawBody: payload, secret: SECRET, now });
    expect(receipt.eventType).toBe("chargeback_confirmed");
    const access = evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "production", useCase: "start",
      now: new Date(now.getTime() + 1000) });
    expect(access).toMatchObject({ allowed: false, state: "suspended_financial" });
  });

  it("rule 45: fraud_or_security_risk revokes immediately as suspended_security", () => {
    const now = new Date("2026-08-15T10:00:00.000Z");
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const payload = JSON.stringify({ provider: "test-provider", eventId: "chargeback-fraud-1",
      eventType: "chargeback_confirmed", subscriptionId, occurredAt: now.toISOString(),
      reasonCategory: "fraud", fraudOrSecurityRisk: true });
    ingestFinancialEventWebhook({ provider: "test-provider", providerEventId: "chargeback-fraud-1",
      timestampSeconds, signatureHex: sign(timestampSeconds, payload), rawBody: payload, secret: SECRET, now });
    const access = evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "production", useCase: "start",
      now: new Date(now.getTime() + 1000) });
    expect(access).toMatchObject({ allowed: false, state: "suspended_security" });
  });

  it("rule 46: a dispute_opened alone does not change access without a configured policy", () => {
    const now = new Date("2026-08-15T10:00:00.000Z");
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const payload = JSON.stringify({ provider: "test-provider", eventId: "dispute-1",
      eventType: "dispute_opened", subscriptionId, occurredAt: now.toISOString() });
    ingestFinancialEventWebhook({ provider: "test-provider", providerEventId: "dispute-1",
      timestampSeconds, signatureHex: sign(timestampSeconds, payload), rawBody: payload, secret: SECRET, now });
    const access = evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "production", useCase: "start",
      now: new Date(now.getTime() + 1000) });
    expect(access.allowed).toBe(true);
  });

  it("rule 47: chargeback_reversed is recorded but not applied by the webhook alone", () => {
    const now = new Date("2026-08-15T10:00:00.000Z");
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const payload = JSON.stringify({ provider: "test-provider", eventId: "reversed-1",
      eventType: "chargeback_reversed", subscriptionId, occurredAt: now.toISOString() });
    ingestFinancialEventWebhook({ provider: "test-provider", providerEventId: "reversed-1",
      timestampSeconds, signatureHex: sign(timestampSeconds, payload), rawBody: payload, secret: SECRET, now });
    const stored = getDb().prepare("select status from financial_dispute_events where provider_event_id='reversed-1'")
      .get() as any;
    expect(stored.status).toBe("received");
    const lifecycleEvents = getDb().prepare(
      "select count(*) n from entitlement_lifecycle_events where source='billing_chargeback'").get() as any;
    expect(lifecycleEvents.n).toBe(0);
  });

  it("rejects an invalid signature", () => {
    const now = new Date("2026-08-15T10:00:00.000Z");
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const payload = JSON.stringify({ provider: "test-provider", eventId: "bad-sig-1",
      eventType: "chargeback_confirmed", subscriptionId, occurredAt: now.toISOString() });
    expect(() => ingestFinancialEventWebhook({ provider: "test-provider", providerEventId: "bad-sig-1",
      timestampSeconds, signatureHex: "0".repeat(64), rawBody: payload, secret: SECRET, now }))
      .toThrow(new BillingAssignmentError("PAYMENT_EVENT_AUTHENTICATION_FAILED"));
  });

  it("rejects a replayed event id", () => {
    const now = new Date("2026-08-15T10:00:00.000Z");
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const payload = JSON.stringify({ provider: "test-provider", eventId: "replay-1",
      eventType: "dispute_opened", subscriptionId, occurredAt: now.toISOString() });
    const signature = sign(timestampSeconds, payload);
    ingestFinancialEventWebhook({ provider: "test-provider", providerEventId: "replay-1",
      timestampSeconds, signatureHex: signature, rawBody: payload, secret: SECRET, now });
    expect(() => ingestFinancialEventWebhook({ provider: "test-provider", providerEventId: "replay-1",
      timestampSeconds, signatureHex: signature, rawBody: payload, secret: SECRET, now }))
      .toThrow(new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED"));
  });
});
