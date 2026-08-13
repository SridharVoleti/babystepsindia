// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { applyPaidCycle } from "@/lib/entitlement-cycle/service";
import { composeParentAttention, composeParentAttentionBadge } from "@/lib/parent-attention/service";

const environment = "production";
const now = new Date("2026-08-13T08:00:00.000Z"); // Thursday, past the ISO-week midpoint
let parentId: string;
let learnerId: string;
let appCounter = 0;

function registerApp(displayName: string) {
  const suffix = ++appCounter;
  const appId = `app-pd003-${suffix}`;
  getDb().prepare(`insert into app_registry
    (id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`)
    .run(appId, appId, displayName);
  return appId;
}

// A genuinely current app: evaluateAccessFresh recomputes active/grace from
// real entitlement periods, never trusting a raw `state` column value for
// those two states (unlike the terminal states below) — so a real paid
// cycle is required, same fixture recipe as UL-001's own composer tests.
function activeApp(learner = learnerId, purchaser = parentId, displayName = "Learning App") {
  const appId = registerApp(displayName);
  applyPaidCycle({
    paidCycleId: `cycle-${appId}`, eventId: `event-${appId}`, eventVersion: 1,
    subscriptionId: `sub-${appId}`, purchaserParentId: purchaser, assignedLearnerId: learner,
    productId: `product-${appId}`, productVersion: 1, appIds: [appId],
    periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z",
    billingAnchor: "2026-08-01", environment, now,
  });
  return appId;
}

// suspended_security is a terminal state evaluateAccessFresh trusts
// directly from the persisted column (checked before any cycle lookup) —
// a direct fixture insert is the correct, established way to construct it
// (same technique EN-004's own tests use for states real but awkward to
// trigger organically end-to-end).
function suspendedSecurityApp(learner = learnerId, displayName = "Learning App") {
  const appId = registerApp(displayName);
  getDb().prepare(`insert into learner_app_effective_entitlements
    (id,learner_id,app_id,environment,state,access_until,effective_version,source_set_hash,created_at,updated_at)
    values(?,?,?,'production','suspended_security',null,1,'source',?,?)`)
    .run(`effective-${appId}`, learner, appId, now.toISOString(), now.toISOString());
  return appId;
}

// app_registry's own insert trigger auto-creates a default 'available' row
// per environment, so this overwrites it rather than inserting.
function seedAvailability(appId: string, operationalState: "temporarily_unavailable" | "security_blocked", message = "Undergoing maintenance.") {
  getDb().prepare(`update app_launch_availability set operational_state=?,availability_version=availability_version+1,
    safe_learner_message=?,updated_at=? where app_id=? and environment='production'`)
    .run(operationalState, message, now.toISOString(), appId);
}

function seedPasskey(learner: string, status: "active" | "revoked" = "active") {
  getDb().prepare(`insert into learner_passkey_credentials
    (id,learner_id,owner_parent_id,credential_id,public_key,sign_count,label,status,device_type,backed_up,created_at)
    values(?,?,?,?,?,0,'Test device',?,'platform',0,?)`)
    .run(randomUUID(), learner, parentId, randomUUID(), "public-key-bytes", status, now.toISOString());
}

function seedSubscription(input: { learner: string; paymentState?: string; status?: string;
  cancelAtPeriodEnd?: boolean; graceEndsAt?: string | null; currentPeriodEnd?: string }) {
  const productId = `product-${randomUUID()}`;
  getDb().prepare(`insert into products(id,slug,name,subdomain,razorpay_plan_id,price_inr,product_type,status,version)
    values(?,?,?,?,?,?,?,'active',1)`)
    .run(productId, `slug-${productId}`, "Test Product", `sub-${productId}`, `plan-${productId}`, 199, "individual_app");
  const subId = `sub-${randomUUID()}`;
  getDb().prepare(`insert into subscriptions(id,user_id,type,assigned_learner_id,purchaser_parent_id,product_id,
    product_version,status,payment_state,cancel_at_period_end,cancellation_effective_at,grace_ends_at,
    razorpay_subscription_id,current_period_end,created_at,updated_at)
    values(?,?,'single',?,?,?,1,?,?,?,?,?,?,?,?,?)`)
    .run(subId, parentId, input.learner, parentId, productId, input.status ?? "active",
      input.paymentState ?? "paid", input.cancelAtPeriodEnd ? 1 : 0,
      input.cancelAtPeriodEnd ? (input.currentPeriodEnd ?? "2026-09-01T00:00:00.000Z") : null,
      input.graceEndsAt ?? null,
      `razorpay-${subId}`, input.currentPeriodEnd ?? "2026-09-01T00:00:00.000Z", now.toISOString(), now.toISOString());
  return subId;
}

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`pd003-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01").learner.id;
});

describe("composeParentAttention — billing", () => {
  it("produces an action_required item for a failed-payment/grace subscription", () => {
    seedSubscription({ learner: learnerId, paymentState: "past_due_grace", graceEndsAt: "2026-08-20T00:00:00.000Z" });
    const result = composeParentAttention(parentId, now);
    expect(result.items).toContainEqual(expect.objectContaining({ category: "billing", severity: "action_required" }));
  });

  it("produces an attention (not action_required) item for a reversible renewal-off subscription", () => {
    seedSubscription({ learner: learnerId, cancelAtPeriodEnd: true, currentPeriodEnd: "2026-09-15T00:00:00.000Z" });
    const result = composeParentAttention(parentId, now);
    const item = result.items.find((i) => i.category === "billing");
    expect(item).toMatchObject({ severity: "attention" });
  });

  it("produces no billing item for a healthy, non-cancelling subscription", () => {
    seedSubscription({ learner: learnerId });
    const result = composeParentAttention(parentId, now);
    expect(result.items.filter((i) => i.category === "billing")).toEqual([]);
  });
});

describe("composeParentAttention — learner_setup (missing passkey)", () => {
  it("flags a learner with a current app and no active passkey", () => {
    activeApp(learnerId);
    const result = composeParentAttention(parentId, now);
    expect(result.items).toContainEqual(expect.objectContaining({ category: "learner_setup", severity: "action_required", learnerId }));
  });

  it("does not flag a learner who already has an active passkey", () => {
    activeApp(learnerId);
    seedPasskey(learnerId, "active");
    const result = composeParentAttention(parentId, now);
    expect(result.items.filter((i) => i.category === "learner_setup")).toEqual([]);
  });

  it("does not flag a learner with zero current apps, even without a passkey", () => {
    const result = composeParentAttention(parentId, now);
    expect(result.items.filter((i) => i.category === "learner_setup")).toEqual([]);
  });

  it("only produces one learner_setup item even with multiple current apps missing a passkey", () => {
    activeApp(learnerId);
    activeApp(learnerId);
    const result = composeParentAttention(parentId, now);
    expect(result.items.filter((i) => i.category === "learner_setup")).toHaveLength(1);
  });
});

describe("composeParentAttention — service_status", () => {
  it("surfaces a current app's temporarily_unavailable state", () => {
    const appId = activeApp(learnerId);
    seedAvailability(appId, "temporarily_unavailable", "Back soon.");
    const result = composeParentAttention(parentId, now);
    expect(result.items).toContainEqual(expect.objectContaining({ category: "service_status", appId, message: "Back soon." }));
  });

  it("produces no service_status item when availability is unknown (no row seeded)", () => {
    activeApp(learnerId);
    const result = composeParentAttention(parentId, now);
    expect(result.items.filter((i) => i.category === "service_status")).toEqual([]);
  });
});

describe("composeParentAttention — access (security suspension)", () => {
  it("shows a safe generic attention item with no CTA route for a suspended_security app", () => {
    const appId = suspendedSecurityApp(learnerId);
    const result = composeParentAttention(parentId, now);
    const item = result.items.find((i) => i.category === "access" && i.appId === appId);
    expect(item).toMatchObject({ severity: "attention", route: null });
    expect(item!.message).not.toMatch(/fraud/i);
  });
});

describe("composeParentAttention — learning_cadence", () => {
  it("reuses EG-006's mid-window timing/feasibility rules and never writes/sends", () => {
    const appId = activeApp(learnerId);
    getDb().prepare(`insert into learner_app_week_usage
      (learner_id,app_id,week_key,week_timezone,normal_sessions_started,standard_sessions_funded,version,updated_at)
      values(?,?,?,'Asia/Kolkata',0,0,1,?)`)
      .run(learnerId, appId, "2026-W33", now.toISOString());
    const before = (getDb().prepare("select count(*) as n from learning_reminder_batches").get() as { n: number }).n;
    const result = composeParentAttention(parentId, now);
    const after = (getDb().prepare("select count(*) as n from learning_reminder_batches").get() as { n: number }).n;
    expect(after).toBe(before);
    expect(result.items).toContainEqual(expect.objectContaining({ category: "learning_cadence", severity: "attention", appId }));
  });

  it("never marks cadence action_required", () => {
    const appId = activeApp(learnerId);
    getDb().prepare(`insert into learner_app_week_usage
      (learner_id,app_id,week_key,week_timezone,normal_sessions_started,standard_sessions_funded,version,updated_at)
      values(?,?,?,'Asia/Kolkata',0,0,1,?)`)
      .run(learnerId, appId, "2026-W33", now.toISOString());
    const result = composeParentAttention(parentId, now);
    const cadence = result.items.filter((i) => i.category === "learning_cadence");
    expect(cadence.every((i) => i.severity === "attention")).toBe(true);
  });
});

describe("composeParentAttention — dedupe, sort, ownership, side effects", () => {
  it("never returns two items with the same sourceKey", () => {
    activeApp(learnerId);
    seedSubscription({ learner: learnerId, paymentState: "renewal_failed" });
    const result = composeParentAttention(parentId, now);
    const keys = result.items.map((i) => i.sourceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("sorts action_required items before attention before info", () => {
    activeApp(learnerId); // -> learner_setup action_required
    seedSubscription({ learner: learnerId, cancelAtPeriodEnd: true }); // -> billing attention
    const result = composeParentAttention(parentId, now);
    const severities = result.items.map((i) => i.severity);
    const firstAttentionIdx = severities.indexOf("attention");
    const lastActionRequiredIdx = severities.lastIndexOf("action_required");
    if (firstAttentionIdx !== -1 && lastActionRequiredIdx !== -1) {
      expect(lastActionRequiredIdx).toBeLessThan(firstAttentionIdx);
    }
  });

  it("never surfaces another parent's learner", async () => {
    const { user: otherParent } = await sqliteAuthAdapter.signUp(`pd003-other-${randomUUID()}@example.com`, "CorrectHorse1!");
    const otherLearner = createLearner(otherParent.id, { displayName: "Other Kid", dateOfBirth: "2018-01-01",
      idempotencyKey: randomUUID() }, "2026-08-01").learner.id;
    activeApp(otherLearner, otherParent.id);
    const result = composeParentAttention(parentId, now);
    expect(result.items.every((i) => i.learnerId !== otherLearner)).toBe(true);
  });

  it("is a pure read — writes nothing to the database", () => {
    activeApp(learnerId);
    seedSubscription({ learner: learnerId, paymentState: "renewal_failed" });
    const tables = ["learner_app_effective_entitlements", "subscriptions", "app_launch_availability",
      "learner_passkey_credentials", "learning_reminder_batches"];
    const before = tables.map((t) => (getDb().prepare(`select count(*) as n from ${t}`).get() as { n: number }).n);
    composeParentAttention(parentId, now);
    const after = tables.map((t) => (getDb().prepare(`select count(*) as n from ${t}`).get() as { n: number }).n);
    expect(after).toEqual(before);
  });

  it("is deterministic — composing twice with the same inputs yields the same version", () => {
    activeApp(learnerId);
    const first = composeParentAttention(parentId, now);
    const second = composeParentAttention(parentId, now);
    expect(second.version).toBe(first.version);
  });
});

describe("composeParentAttentionBadge", () => {
  it("summarizes counts and a bounded preview matching the full composition", () => {
    activeApp(learnerId); // learner_setup action_required
    seedSubscription({ learner: learnerId, cancelAtPeriodEnd: true }); // billing attention
    const full = composeParentAttention(parentId, now);
    const badge = composeParentAttentionBadge(parentId, now);
    expect(badge.version).toBe(full.version);
    expect(badge.actionRequiredCount).toBe(full.items.filter((i) => i.severity === "action_required").length);
    expect(badge.attentionCount).toBe(full.items.filter((i) => i.severity === "attention").length);
    expect(badge.hasItems).toBe(full.items.length > 0);
    expect(badge.preview).toEqual(full.items.slice(0, 3));
  });
});
