import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner, updateLearner } from "@/lib/db/learner-repo";
import {
  applyDueSubscriptionReassignment,
  applyVerifiedCheckoutPayment,
  createCheckoutIntent,
  createReassignmentCase,
  defineProductVersion,
  executeSubscriptionReassignment,
  getAdminReassignmentCase,
  listParentSubscriptions,
} from "@/lib/billing/bi001-service";
import { BillingAssignmentError } from "@/lib/billing/errors";
import type { BillingCheckoutProviderAdapter } from "@/lib/billing/provider-adapter";

const NOW = new Date("2026-08-10T10:00:00.000Z");
const PERIOD_END = "2026-09-10T10:00:00.000Z";
const APP_MATH = "app-math";
const APP_READING = "app-reading";
let parentId: string;
let sourceLearnerId: string;
let targetLearnerId: string;
let productId: string;

const provider: BillingCheckoutProviderAdapter = {
  createCheckout(input) {
    return { provider: "verified-test", providerCheckoutRef: `checkout:${input.checkoutIntentId}`,
      handoff: { url: `/provider/${input.checkoutIntentId}`, method: "GET" } };
  },
};

async function parent(email: string) {
  return (await sqliteAuthAdapter.signUp(email, "CorrectHorse1!")).user.id;
}

async function learner(owner: string, name: string, key: string) {
  return (await createLearner(owner, { displayName: name, dateOfBirth: "2018-01-01", idempotencyKey: key }, "2026-08-10")).learner.id;
}

function seedApp(id: string, name: string) {
  getDb().prepare(
    `insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
     values(?,?,?,'Learning app','icon-open-book','learning','team','active')`,
  ).run(id, id, name);
}

function createProduct(overrides: Partial<Parameters<typeof defineProductVersion>[0]> = {}) {
  return defineProductVersion({ id: "product-math", slug: "math-monthly", name: "Math Monthly",
    subdomain: "math.example.test", planReference: "plan_math", priceInr: 299,
    productType: "individual_app", version: 1, appIds: [APP_MATH], ...overrides });
}

function activate(learnerId = sourceLearnerId, suffix = "1", product = productId) {
  const checkout = createCheckoutIntent(parentId, { learnerId, productId: product, productVersion: 1,
    idempotencyKey: `checkout-${suffix}` }, { now: NOW, provider });
  return applyVerifiedCheckoutPayment({ provider: checkout.provider,
    providerEventId: `event-${suffix}`, checkoutIntentId: checkout.checkoutIntentId,
    providerCheckoutRef: checkout.providerCheckoutRef, purchaserParentId: parentId,
    assignedLearnerId: learnerId, productId: product, productVersion: 1, paymentStatus: "paid",
    providerSubscriptionRef: `provider-sub-${suffix}`, providerCustomerRef: `customer-${parentId}`,
    periodStart: NOW.toISOString(), periodEnd: PERIOD_END }, NOW)!;
}

function caseFor(subscriptionId: string, suffix = "1") {
  return createReassignmentCase(parentId, { subscriptionId, targetLearnerId,
    reasonCode: "WRONG_LEARNER_SELECTED", notes: "Please correct the assignment.",
    idempotencyKey: `case-${suffix}` }, NOW);
}

function execute(subscriptionId: string, caseId: string, mode: "immediate_if_unused" | "next_period",
  key = "admin-request-1") {
  const subscription = getDb().prepare("select version from subscriptions where id=?").get(subscriptionId) as { version: number };
  const assignmentCase = getDb().prepare("select version from subscription_reassignment_cases where id=?").get(caseId) as { version: number };
  return executeSubscriptionReassignment("admin-1", subscriptionId, { caseId, targetLearnerId,
    effectiveMode: mode, reasonCode: "WRONG_LEARNER_SELECTED",
    expectedSubscriptionVersion: subscription.version, expectedCaseVersion: assignmentCase.version,
    idempotencyKey: key }, NOW);
}

function seedSession(learnerId: string, status: "starting" | "active" | "disconnected" | "completed",
  usable = status === "completed") {
  const id = `session-${learnerId}-${status}`;
  getDb().prepare(
    `insert into learner_sessions(id,learner_id,app_id,parent_user_id,device_session_id,week_key,week_timezone,
     weekly_slot_number,source,status,funding_state,schedule_authorization_id,started_at,resume_token_hash,
     usable_launch_established_at,created_at,updated_at)
     values(?,?,?,?,?,'2026-W33','Asia/Kolkata',1,'normal',?,?,?,?,?,?,?,?)`,
  ).run(id, learnerId, APP_MATH, parentId, "device-1", status,
    usable ? "consumed" : "reserved", "schedule-1", NOW.toISOString(), "hash",
    usable ? NOW.toISOString() : null, NOW.toISOString(), NOW.toISOString());
  return id;
}

beforeEach(async () => {
  useInMemoryDb();
  seedApp(APP_MATH, "Magical Math");
  seedApp(APP_READING, "Speed Reading");
  parentId = await parent("billing-parent@example.com");
  sourceLearnerId = await learner(parentId, "Asha", "10000000-0000-4000-8000-000000000001");
  targetLearnerId = await learner(parentId, "Ravi", "10000000-0000-4000-8000-000000000002");
  productId = createProduct().id;
  getDb().prepare("insert into users(id,email,password_hash,email_verified_at) values('admin-1','billing-admin@example.com','x',?)")
    .run(NOW.toISOString());
  getDb().prepare("insert into profiles(id,display_name,onboarding_status) values('admin-1','Billing Admin','complete')").run();
});

describe("BI-001 purchase and immutable learner assignment", () => {
  it("AT-BI-001-01..04 derives purchaser from auth, binds one owned learner and returns explicit confirmation", () => {
    const checkout = createCheckoutIntent(parentId, { learnerId: sourceLearnerId, productId, productVersion: 1,
      idempotencyKey: "checkout-owned" }, { now: NOW, provider });
    expect(checkout).toMatchObject({ purchaserParentId: parentId,
      assignedLearner: { id: sourceLearnerId, displayName: "Asha" },
      product: { id: productId, version: 1 }, assignmentLockedAfterActivation: true, status: "pending_provider" });
    const row = getDb().prepare("select * from checkout_intents where id=?").get(checkout.checkoutIntentId) as any;
    expect(row).toMatchObject({ purchaser_parent_id: parentId, assigned_learner_id: sourceLearnerId,
      product_id: productId, product_version: 1 });
  });

  it("AT-BI-001-03 denies a foreign learner without creating an intent", async () => {
    const otherParent = await parent("other@example.com");
    const foreign = await learner(otherParent, "Other", "10000000-0000-4000-8000-000000000003");
    expect(() => createCheckoutIntent(parentId, { learnerId: foreign, productId, productVersion: 1,
      idempotencyKey: "foreign" }, { now: NOW, provider })).toThrow(new BillingAssignmentError("RESOURCE_NOT_FOUND"));
    expect((getDb().prepare("select count(*) n from checkout_intents").get() as { n: number }).n).toBe(0);
  });

  it("AT-BI-001-05..07 supports one-app and bundle snapshots without learner arrays", () => {
    const bundle = createProduct({ id: "bundle-1", slug: "bundle", name: "All Apps", planReference: "plan_bundle",
      productType: "bundle", appIds: [APP_MATH, APP_READING] });
    const activated = activate(sourceLearnerId, "bundle", bundle.id);
    expect(activated.assignedLearnerId).toBe(sourceLearnerId);
    const row = getDb().prepare("select * from subscriptions where id=?").get(activated.subscriptionId) as any;
    expect(row.type).toBe("bundle");
    expect(row.assigned_learner_id).toBe(sourceLearnerId);
    expect(Object.keys(row)).not.toContain("learner_ids");
    expect((getDb().prepare("select count(*) n from product_version_apps where product_id=?").get(bundle.id) as { n: number }).n).toBe(2);
  });

  it("AT-BI-001-08 exact checkout retry returns original; a conflicting retry is rejected", () => {
    const input = { learnerId: sourceLearnerId, productId, productVersion: 1, idempotencyKey: "retry" };
    const first = createCheckoutIntent(parentId, input, { now: NOW, provider });
    expect(createCheckoutIntent(parentId, input, { now: NOW, provider })).toEqual(first);
    expect(() => createCheckoutIntent(parentId, { ...input, learnerId: targetLearnerId }, { now: NOW, provider }))
      .toThrow(new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED"));
  });

  it("AT-BI-001-09 failed payment creates no active subscription", () => {
    const checkout = createCheckoutIntent(parentId, { learnerId: sourceLearnerId, productId, productVersion: 1,
      idempotencyKey: "failed" }, { now: NOW, provider });
    expect(applyVerifiedCheckoutPayment({ provider: checkout.provider, providerEventId: "failed-event",
      checkoutIntentId: checkout.checkoutIntentId, providerCheckoutRef: checkout.providerCheckoutRef,
      purchaserParentId: parentId, assignedLearnerId: sourceLearnerId, productId, productVersion: 1,
      paymentStatus: "failed", providerSubscriptionRef: "none", periodStart: NOW.toISOString(), periodEnd: PERIOD_END }, NOW))
      .toBeNull();
    expect((getDb().prepare("select count(*) n from subscriptions").get() as { n: number }).n).toBe(0);
  });

  it("AT-BI-001-10 rejects a provider context mismatch atomically", () => {
    const checkout = createCheckoutIntent(parentId, { learnerId: sourceLearnerId, productId, productVersion: 1,
      idempotencyKey: "mismatch" }, { now: NOW, provider });
    expect(() => applyVerifiedCheckoutPayment({ provider: checkout.provider, providerEventId: "mismatch-event",
      checkoutIntentId: checkout.checkoutIntentId, providerCheckoutRef: checkout.providerCheckoutRef,
      purchaserParentId: parentId, assignedLearnerId: targetLearnerId, productId, productVersion: 1,
      paymentStatus: "paid", providerSubscriptionRef: "provider-sub", periodStart: NOW.toISOString(), periodEnd: PERIOD_END }, NOW))
      .toThrow(new BillingAssignmentError("CHECKOUT_CONTEXT_MISMATCH"));
    expect((getDb().prepare("select count(*) n from subscriptions").get() as { n: number }).n).toBe(0);
  });

  it("AT-BI-001-11 has no self-service assignment mutation and AT-BI-001-12 learner rename keeps the ID", async () => {
    const active = activate();
    await updateLearner(parentId, sourceLearnerId, { displayName: "Asha New", expectedVersion: 1,
      idempotencyKey: "10000000-0000-4000-8000-000000000099" }, "2026-08-10");
    const summary = listParentSubscriptions(parentId).items[0];
    expect(summary.assignedLearner).toEqual({ id: sourceLearnerId, displayName: "Asha New" });
    expect(summary.assignmentSelfServiceEditable).toBe(false);
    expect((getDb().prepare("select assigned_learner_id from subscriptions where id=?").get(active.subscriptionId) as any)
      .assigned_learner_id).toBe(sourceLearnerId);
  });
});

describe("BI-001 case-based administrator reassignment", () => {
  it("AT-BI-001-13 creates an open parent case without changing assignment", () => {
    const active = activate();
    const created = caseFor(active.subscriptionId);
    expect(created).toMatchObject({ status: "open", sourceLearnerId, targetLearnerId });
    expect((getDb().prepare("select assigned_learner_id from subscriptions where id=?").get(active.subscriptionId) as any)
      .assigned_learner_id).toBe(sourceLearnerId);
  });

  it("AT-BI-001-16 rejects a cross-parent target non-enumerating", async () => {
    const active = activate();
    const otherParent = await parent("foreign-target@example.com");
    const foreign = await learner(otherParent, "Foreign", "10000000-0000-4000-8000-000000000004");
    expect(() => createReassignmentCase(parentId, { subscriptionId: active.subscriptionId,
      targetLearnerId: foreign, reasonCode: "WRONG_LEARNER_SELECTED", idempotencyKey: "foreign-case" }, NOW))
      .toThrow(new BillingAssignmentError("RESOURCE_NOT_FOUND"));
  });

  it("AT-BI-001-17 denies permanently ended/refunded/disputed states", () => {
    for (const status of ["expired", "refunded", "disputed"] as const) {
      const active = activate(sourceLearnerId, status);
      const created = caseFor(active.subscriptionId, status);
      getDb().prepare("update subscriptions set status=? where id=?").run(status, active.subscriptionId);
      expect(() => execute(active.subscriptionId, created.caseId, "immediate_if_unused", `admin-${status}`))
        .toThrow(new BillingAssignmentError("SUBSCRIPTION_REASSIGNMENT_NOT_ALLOWED"));
    }
  });

  it("AT-BI-001-18 rejects target product/app overlap", () => {
    const sourceSubscription = activate(sourceLearnerId, "source");
    activate(targetLearnerId, "target");
    const created = caseFor(sourceSubscription.subscriptionId, "overlap");
    expect(() => execute(sourceSubscription.subscriptionId, created.caseId, "immediate_if_unused"))
      .toThrow(new BillingAssignmentError("TARGET_SUBSCRIPTION_CONFLICT"));
  });

  it.each([["source", () => sourceLearnerId], ["target", () => targetLearnerId]] as const)(
    "AT-BI-001-19/20 blocks an affected active %s learner session",
    (_label, learnerFactory) => {
      const active = activate();
      const created = caseFor(active.subscriptionId);
      seedSession(learnerFactory(), "active");
      expect(() => execute(active.subscriptionId, created.caseId, "immediate_if_unused"))
        .toThrow(new BillingAssignmentError("LEARNER_SESSION_IN_PROGRESS"));
    },
  );

  it("AT-BI-001-21 immediate unused correction updates assignment and emits one event", () => {
    const active = activate();
    const created = caseFor(active.subscriptionId);
    const result = execute(active.subscriptionId, created.caseId, "immediate_if_unused");
    expect(result).toMatchObject({ status: "executed", sourceLearnerId, targetLearnerId, assignmentVersion: 2 });
    expect((getDb().prepare("select assigned_learner_id from subscriptions where id=?").get(active.subscriptionId) as any)
      .assigned_learner_id).toBe(targetLearnerId);
    expect((getDb().prepare("select count(*) n from account_events where event_type='subscription_assignment_changed'").get() as { n: number }).n).toBe(1);
  });

  it("AT-BI-001-22 used subscription cannot be corrected immediately", () => {
    const active = activate();
    const created = caseFor(active.subscriptionId);
    seedSession(sourceLearnerId, "completed", true);
    expect(() => execute(active.subscriptionId, created.caseId, "immediate_if_unused"))
      .toThrow(new BillingAssignmentError("REASSIGNMENT_SCHEDULE_REQUIRED"));
  });

  it("AT-BI-001-23..26 schedules a used subscription and switches atomically at the boundary without moving history", async () => {
    const active = activate();
    const created = caseFor(active.subscriptionId);
    const historicalSessionId = seedSession(sourceLearnerId, "completed", true);
    const scheduled = execute(active.subscriptionId, created.caseId, "next_period");
    expect(scheduled).toMatchObject({ status: "scheduled", effectiveAt: PERIOD_END });
    expect((getDb().prepare("select assigned_learner_id from subscriptions where id=?").get(active.subscriptionId) as any)
      .assigned_learner_id).toBe(sourceLearnerId);
    const applied = await applyDueSubscriptionReassignment(active.subscriptionId, new Date(PERIOD_END));
    expect(applied).toMatchObject({ applied: true, sourceLearnerId, targetLearnerId, assignmentVersion: 2 });
    expect((getDb().prepare("select learner_id from learner_sessions where id=?").get(historicalSessionId) as any).learner_id)
      .toBe(sourceLearnerId);
  });

  it("AT-BI-001-27 purchaser is structurally immutable", () => {
    const active = activate();
    expect(() => getDb().prepare("update subscriptions set purchaser_parent_id='other',user_id='other' where id=?")
      .run(active.subscriptionId)).toThrow(/purchaser is immutable/);
  });

  it("AT-BI-001-28 closed/rejected/executed cases cannot execute", () => {
    const active = activate();
    const created = caseFor(active.subscriptionId);
    getDb().prepare("update subscription_reassignment_cases set status='closed' where id=?").run(created.caseId);
    expect(() => execute(active.subscriptionId, created.caseId, "immediate_if_unused"))
      .toThrow(new BillingAssignmentError("CASE_NOT_ACTIVE"));
  });

  it("AT-BI-001-29/30 exact admin retry returns original; conflicting reuse is rejected", () => {
    const active = activate();
    const created = caseFor(active.subscriptionId);
    const first = execute(active.subscriptionId, created.caseId, "immediate_if_unused", "admin-retry");
    const retry = executeSubscriptionReassignment("admin-1", active.subscriptionId, { caseId: created.caseId,
      targetLearnerId, effectiveMode: "immediate_if_unused", reasonCode: "WRONG_LEARNER_SELECTED",
      expectedSubscriptionVersion: 1, expectedCaseVersion: 1, idempotencyKey: "admin-retry" }, NOW);
    expect(retry).toEqual(first);
    expect(() => executeSubscriptionReassignment("admin-1", active.subscriptionId, { caseId: created.caseId,
      targetLearnerId, effectiveMode: "next_period", reasonCode: "WRONG_LEARNER_SELECTED",
      expectedSubscriptionVersion: 1, expectedCaseVersion: 1, idempotencyKey: "admin-retry" }, NOW))
      .toThrow(new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED"));
  });

  it("AT-BI-001-31 stale subscription or case versions cause no partial change", () => {
    const active = activate();
    const created = caseFor(active.subscriptionId);
    expect(() => executeSubscriptionReassignment("admin-1", active.subscriptionId, { caseId: created.caseId,
      targetLearnerId, effectiveMode: "immediate_if_unused", reasonCode: "WRONG_LEARNER_SELECTED",
      expectedSubscriptionVersion: 99, expectedCaseVersion: 1, idempotencyKey: "stale" }, NOW))
      .toThrow(new BillingAssignmentError("VERSION_CONFLICT"));
    expect((getDb().prepare("select assigned_learner_id from subscriptions where id=?").get(active.subscriptionId) as any)
      .assigned_learner_id).toBe(sourceLearnerId);
  });

  it("AT-BI-001-32 outbox failure rolls back assignment and case state", () => {
    const active = activate();
    const created = caseFor(active.subscriptionId);
    getDb().exec(`create trigger fail_bi001_outbox before insert on account_events
      when new.event_type='subscription_assignment_changed' begin select raise(abort,'outbox failed'); end`);
    expect(() => execute(active.subscriptionId, created.caseId, "immediate_if_unused")).toThrow(/outbox failed/);
    expect((getDb().prepare("select assigned_learner_id from subscriptions where id=?").get(active.subscriptionId) as any)
      .assigned_learner_id).toBe(sourceLearnerId);
    expect((getDb().prepare("select status from subscription_reassignment_cases where id=?").get(created.caseId) as any).status)
      .toBe("open");
  });

  it("AT-BI-001-33..35 keeps app/payment/log boundaries narrow and assignment device-independent", () => {
    const active = activate();
    const created = caseFor(active.subscriptionId);
    const adminView = getAdminReassignmentCase(created.caseId);
    expect(JSON.stringify(adminView)).not.toMatch(/password|card|payment.instrument/i);
    const events = getDb().prepare("select metadata from account_events where event_type like 'subscription_%'").all() as { metadata: string }[];
    expect(JSON.stringify(events)).not.toContain("Please correct the assignment.");
    const columns = getDb().prepare("pragma table_info(subscriptions)").all().map((row: any) => row.name);
    expect(columns).not.toContain("device_id");
    expect(columns).not.toContain("learner_ids");
    expect(active.assignedLearnerId).toBe(sourceLearnerId);
  });
});
