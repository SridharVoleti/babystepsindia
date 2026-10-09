import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createCheckoutIntent, defineProductVersion, getProductPurchaseView } from "@/lib/billing/bi001-service";
import { processVerifiedPaymentEvent } from "@/lib/billing/bi002-service";
import { BILLING_CONSENT_DISCLOSURE_VERSION } from "@/lib/billing/contracts";
import type { BillingCheckoutProviderAdapter } from "@/lib/billing/provider-adapter";
import { runEntitlementIntegritySweep } from "@/lib/entitlement-integrity/sweep";
import { runReverseEntitlementIntegritySweep } from "@/lib/entitlement-integrity/reverse-sweep";
import { applyIncidentAction } from "@/lib/entitlement-integrity/incidents";
import { evaluateAccessFresh } from "@/lib/entitlement-access/service";

// PRG-039 / EN-004 (issue #61): reverse reconciliation - entitlement targets without verified source truth are detected, quarantined and audited.
const APP_ID = "app-prg039";
const ACCOUNT_ID = "acct-prg039";
const NOW = new Date("2026-08-25T00:00:00.000Z");
let parentId: string;
let productId: string;

const provider: BillingCheckoutProviderAdapter = {
  createCheckout(input) { return { provider: "contract-provider", environment: "test", accountId: ACCOUNT_ID,
    providerCheckoutRef: `checkout:${input.checkoutIntentId}`, providerSubscriptionRef: `provider-sub:${input.checkoutIntentId}`,
    providerMandateRef: `mandate:${input.checkoutIntentId}`, handoff: { url: `/provider/${input.checkoutIntentId}`, method: "GET" } }; },
  disableAutoRenewal: vi.fn(() => ({ confirmed: true as const })),
  getRecurringAgreementStatus() { return { status: "valid" as const }; },
  enableAutoRenewal: vi.fn(() => ({ confirmed: true as const })),
  stopRenewalRetries() { return { confirmed: true }; },
  listReconciliationEvents() { return { events: [], nextCursor: null }; },
};

async function activateFor(key: string) {
  const learnerId = (await createLearner(parentId, { displayName: `Learner-${key}`, dateOfBirth: "2018-02-10", idempotencyKey: `idemp-${key}` }, "2026-08-10")).learner.id;
  const view = await getProductPurchaseView(productId);
  const created = await createCheckoutIntent(parentId, { learnerId, productId, productVersion: view.version, priceId: view.price.id, priceVersion: view.price.version,
    autoRenewEnabled: true, consentDisclosureVersion: BILLING_CONSENT_DISCLOSURE_VERSION, idempotencyKey: key },
  { now: new Date("2026-08-10T09:59:00.000Z"), provider });
  const intent = getDb().prepare("select * from checkout_intents where id=?").get(created.checkoutIntentId) as any;
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(intent.subscription_id) as any;
  const result = await processVerifiedPaymentEvent({ provider: intent.provider, environment: intent.provider_environment, accountId: intent.provider_account_id,
    providerEventId: `activation:${key}`, eventType: "initial_payment_succeeded", checkoutIntentId: intent.id, providerCheckoutRef: intent.provider_checkout_ref,
    providerPaymentRef: `initial-payment:${key}`, providerSubscriptionRef: subscription.provider_subscription_ref, providerMandateRef: intent.provider_mandate_ref,
    amount: intent.amount, currency: intent.currency, priceId: intent.price_id, priceVersion: intent.price_version, settledAt: "2026-08-10T10:00:00.000Z" },
  new Date("2026-08-10T10:01:00.000Z")) as any;
  return { learnerId, subscriptionId: result.subscriptionId as string, billingPeriodId: result.billingPeriodId as string };
}

const effective = (learnerId: string) => getDb().prepare("select * from learner_app_effective_entitlements where learner_id=?").get(learnerId) as any;
const incidents = (sourceId: string) => getDb().prepare("select * from entitlement_integrity_incidents where source_id=?").all(sourceId) as any[];
const receipts = (sourceId: string) => getDb().prepare("select * from entitlement_reconciliation_receipts where source_id=? and source_type='paid_cycle'").all(sourceId) as any[];
const counts = () => ({
  cycles: (getDb().prepare("select count(*) n from entitlement_cycles").get() as any).n,
  periods: (getDb().prepare("select count(*) n from learner_app_entitlement_periods").get() as any).n,
  effective: (getDb().prepare("select count(*) n from learner_app_effective_entitlements").get() as any).n,
  billing: (getDb().prepare("select count(*) n from billing_periods").get() as any).n,
});
const sweep = (key: string, extra: Record<string, unknown> = {}) =>
  runReverseEntitlementIntegritySweep("integrity-monitor", { environment: "test", limit: 50, runIdempotencyKey: key, ...extra }, NOW);
const access = (learnerId: string) => evaluateAccessFresh({ learnerId, appId: APP_ID, environment: "test", useCase: "start", now: new Date("2026-08-15T00:00:00.000Z") });

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,'Math App','Math','icon-abacus','learning','team','active')`).run(APP_ID, APP_ID);
  parentId = (await sqliteAuthAdapter.signUp("prg039-parent@example.com", "CorrectHorse1!")).user.id;
  productId = (await defineProductVersion({ id: "product-prg039", slug: "prg039-monthly", name: "Math Monthly", subdomain: "prg039.example.test",
    planReference: "plan-prg039", priceInr: 299, productType: "individual_app", version: 1, appIds: [APP_ID] })).id;
});

describe("reverse detection of entitlement targets without verified source truth", () => {
  it("healthy entitlements are untouched and still grant access", async () => {
    const ok = await activateFor("healthy");
    expect((await access(ok.learnerId)).allowed).toBe(true);
    const result = await sweep("rev-1");
    expect(result).toMatchObject({ processed: 1, healthyCount: 1, incidentsOpenedCount: 0 });
    expect(effective(ok.learnerId).integrity_state).toBe("healthy");
    expect(incidents(ok.billingPeriodId)).toHaveLength(0);
    expect((await access(ok.learnerId)).allowed).toBe(true);
  });

  it("a deleted source record (no billing rows at all for the subscription) is an orphan the forward sweep cannot reach", async () => {
    const orphan = await activateFor("deleted-source");
    getDb().pragma("foreign_keys = OFF");
    getDb().prepare("delete from billing_periods where subscription_id=?").run(orphan.subscriptionId);
    const forward = await runEntitlementIntegritySweep("integrity-monitor", { environment: "test", limit: 50, runIdempotencyKey: "fwd-1" }, NOW);
    expect(forward.incidentsOpenedCount).toBe(0);                                   // documents the pre-fix blind spot
    const result = await sweep("rev-2");
    expect(result.incidentsOpenedCount).toBe(1);
    const inc = incidents(orphan.billingPeriodId);
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ category: "ENTITLEMENT_WITHOUT_VERIFIED_SOURCE", target_type: "entitlement_cycle", status: "open", environment: "test" });
  });

  it("a deleted subscription is detected, with environment taken from the entitlement itself", async () => {
    const orphan = await activateFor("deleted-subscription");
    getDb().pragma("foreign_keys = OFF");
    getDb().prepare("delete from billing_periods where subscription_id=?").run(orphan.subscriptionId);
    getDb().prepare("delete from subscriptions where id=?").run(orphan.subscriptionId);
    expect((await sweep("rev-3")).incidentsOpenedCount).toBe(1);
    expect(incidents(orphan.billingPeriodId)[0].environment).toBe("test");
  });

  it("a stale entitlement after the source was rolled back (no longer paid) is an orphan", async () => {
    const stale = await activateFor("rolled-back");
    getDb().prepare("update billing_periods set status='failed' where id=?").run(stale.billingPeriodId);
    expect((await sweep("rev-4")).incidentsOpenedCount).toBe(1);
    expect(incidents(stale.billingPeriodId)[0].category).toBe("ENTITLEMENT_WITHOUT_VERIFIED_SOURCE");
  });

  it("a source that belongs to a different subscription is not a verified source", async () => {
    const a = await activateFor("mismatch-a");
    const b = await activateFor("mismatch-b");
    getDb().prepare("update entitlement_cycles set subscription_id=? where paid_cycle_id=?").run(b.subscriptionId, a.billingPeriodId);   // cycle A now claims B's subscription
    const result = await sweep("rev-5");
    expect(result.incidentsOpenedCount).toBe(1);
    expect(incidents(a.billingPeriodId)).toHaveLength(1);
    expect(incidents(b.billingPeriodId)).toHaveLength(0);
  });

  it("creating/failed cycles are not 'ready' targets and are left to forward reconciliation", async () => {
    const x = await activateFor("not-ready");
    getDb().prepare("update entitlement_cycles set status='failed' where paid_cycle_id=?").run(x.billingPeriodId);
    getDb().pragma("foreign_keys = OFF");
    getDb().prepare("delete from billing_periods where subscription_id=?").run(x.subscriptionId);
    expect((await sweep("rev-6")).incidentsOpenedCount).toBe(0);
  });
});

describe("invalid access cannot silently remain active; the action is auditable", () => {
  async function orphaned(key: string) {
    const o = await activateFor(key);
    getDb().pragma("foreign_keys = OFF");
    getDb().prepare("delete from billing_periods where subscription_id=?").run(o.subscriptionId);
    return o;
  }

  it("access is granted before and denied after the sweep quarantines the orphan", async () => {
    const o = await orphaned("deny");
    expect((await access(o.learnerId)).allowed).toBe(true);                       // the pre-fix silent-continuation hazard
    await sweep("rev-7");
    expect(effective(o.learnerId).integrity_state).toBe("quarantined");
    const decision = await access(o.learnerId);
    expect(decision.allowed).toBe(false);
  });

  it("audit visibility precedes corrective action: incident and receipt exist for every quarantine", async () => {
    const o = await orphaned("audit");
    await sweep("rev-8");
    expect(incidents(o.billingPeriodId)).toHaveLength(1);
    expect(receipts(o.billingPeriodId)).toMatchObject([{ action: "incident", result: "failed", principal_id: "integrity-monitor" }]);
    expect(effective(o.learnerId).integrity_state).toBe("quarantined");
  });

  it("only the orphan is quarantined; other learners keep access", async () => {
    const bad = await orphaned("bad");
    const good = await activateFor("good");
    await sweep("rev-9");
    expect(effective(bad.learnerId).integrity_state).toBe("quarantined");
    expect(effective(good.learnerId).integrity_state).toBe("healthy");
    expect((await access(good.learnerId)).allowed).toBe(true);
  });

  it("reconciliation never creates entitlement or billing state from target state alone", async () => {
    await orphaned("no-create");
    const before = counts();
    await sweep("rev-10");
    expect(counts()).toEqual(before);
  });

  it("an existing session binding (resume) is not affected, only new access", async () => {
    const o = await orphaned("resume");
    const effId = effective(o.learnerId).id;
    await sweep("rev-11");
    const resume = await evaluateAccessFresh({ learnerId: o.learnerId, appId: APP_ID, environment: "test", useCase: "resume", boundEffectiveEntitlementId: effId, now: new Date("2026-08-15T00:00:00.000Z") });
    expect(resume.allowed).toBe(true);
  });
});

describe("idempotency, paging and isolation", () => {
  it("repeated reconciliation is idempotent: one incident, one receipt row, still quarantined", async () => {
    const o = await activateFor("idem");
    getDb().pragma("foreign_keys = OFF");
    getDb().prepare("delete from billing_periods where subscription_id=?").run(o.subscriptionId);
    await sweep("rev-12");
    await sweep("rev-13");
    expect(incidents(o.billingPeriodId)).toHaveLength(1);
    expect(incidents(o.billingPeriodId)[0].attempt_count).toBe(1);                  // created at 0, the repeat pass updates rather than duplicates
    expect(receipts(o.billingPeriodId)).toHaveLength(1);
    expect(effective(o.learnerId).integrity_state).toBe("quarantined");
  });

  it("the same run key and cursor returns the cached page without reprocessing", async () => {
    await activateFor("cached");
    const first = await sweep("rev-14");
    const second = await runReverseEntitlementIntegritySweep("integrity-monitor", { environment: "test", limit: 50, runIdempotencyKey: "rev-14" }, new Date("2026-08-25T01:00:00.000Z"));
    expect(second).toEqual(first);
  });

  it("is bounded and paginates by id cursor", async () => {
    await activateFor("p-a"); await activateFor("p-b"); await activateFor("p-c");
    const page1 = await sweep("rev-15", { limit: 2 });
    expect(page1.processed).toBe(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await sweep("rev-16", { limit: 2, cursor: page1.nextCursor });
    expect(page2.processed).toBe(1);
    expect(page2.nextCursor).toBeNull();
  });

  it("environment isolation: a production sweep never touches a test-environment orphan", async () => {
    const o = await activateFor("env");
    getDb().pragma("foreign_keys = OFF");
    getDb().prepare("delete from billing_periods where subscription_id=?").run(o.subscriptionId);
    const result = await runReverseEntitlementIntegritySweep("integrity-monitor", { environment: "production", limit: 50, runIdempotencyKey: "rev-17" }, NOW);
    expect(result.incidentsOpenedCount).toBe(0);
    expect(effective(o.learnerId).integrity_state).toBe("healthy");
  });

  it("does not collide with the forward sweep's run ledger when given the same key", async () => {
    await activateFor("keys");
    await runEntitlementIntegritySweep("integrity-monitor", { environment: "test", limit: 50, runIdempotencyKey: "shared-key" }, NOW);
    const reverse = await sweep("shared-key");
    expect(reverse.processed).toBe(1);
  });
});

describe("repair and quarantine release are auditable", () => {
  it("resolving the incident as a false positive releases the quarantine (audited action)", async () => {
    const o = await activateFor("release");
    getDb().pragma("foreign_keys = OFF");
    getDb().prepare("delete from billing_periods where subscription_id=?").run(o.subscriptionId);
    await sweep("rev-18");
    const inc = incidents(o.billingPeriodId)[0];
    const admin = (await sqliteAuthAdapter.signUp("prg039-admin@example.com", "CorrectHorse1!")).user.id;
    const res = await applyIncidentAction({ incidentId: inc.id, action: "resolve_false_positive", actorAdminId: admin, expectedVersion: inc.version, idempotencyKey: "act-1", reasonCategory: "verified_source_exists", now: NOW });
    expect(res).toMatchObject({ result: "applied", incidentStatus: "resolved_false_positive" });
    expect(effective(o.learnerId).integrity_state).toBe("healthy");
    expect(getDb().prepare("select count(*) n from entitlement_integrity_incident_actions where incident_id=?").get(inc.id)).toMatchObject({ n: 1 });
  });

  it("a rejected action (missing reason) leaves the quarantine in place", async () => {
    const o = await activateFor("keep");
    getDb().pragma("foreign_keys = OFF");
    getDb().prepare("delete from billing_periods where subscription_id=?").run(o.subscriptionId);
    await sweep("rev-19");
    const inc = incidents(o.billingPeriodId)[0];
    const admin = (await sqliteAuthAdapter.signUp("prg039-admin2@example.com", "CorrectHorse1!")).user.id;
    const res = await applyIncidentAction({ incidentId: inc.id, action: "resolve_false_positive", actorAdminId: admin, expectedVersion: inc.version, idempotencyKey: "act-2", now: NOW });
    expect(res.result).toBe("rejected");
    expect(effective(o.learnerId).integrity_state).toBe("quarantined");
  });
});
