// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { applyPaidCycle } from "@/lib/entitlement-cycle/service";
import {
  composeParentAttention,
  composeParentAttentionBadge,
  composeParentAttentionList,
  composeParentAttentionSummary,
  ParentAttentionRequestError,
} from "@/lib/parent-attention/service";

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
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
});

describe("composeParentAttention — billing", () => {
  it("produces an action_required item for a failed-payment/grace subscription", async () => {
    seedSubscription({ learner: learnerId, paymentState: "past_due_grace", graceEndsAt: "2026-08-20T00:00:00.000Z" });
    const result = await composeParentAttention(parentId, now);
    expect(result.items).toContainEqual(expect.objectContaining({ category: "billing", severity: "action_required" }));
  });

  it("produces an attention (not action_required) item for a reversible renewal-off subscription", async () => {
    seedSubscription({ learner: learnerId, cancelAtPeriodEnd: true, currentPeriodEnd: "2026-09-15T00:00:00.000Z" });
    const result = await composeParentAttention(parentId, now);
    const item = result.items.find((i) => i.category === "billing");
    expect(item).toMatchObject({ severity: "attention" });
  });

  it("produces no billing item for a healthy, non-cancelling subscription", async () => {
    seedSubscription({ learner: learnerId });
    const result = await composeParentAttention(parentId, now);
    expect(result.items.filter((i) => i.category === "billing")).toEqual([]);
  });
});

describe("composeParentAttention — learner_setup (missing passkey)", () => {
  it("flags a learner with a current app and no active passkey", async () => {
    activeApp(learnerId);
    const result = await composeParentAttention(parentId, now);
    expect(result.items).toContainEqual(expect.objectContaining({ category: "learner_setup", severity: "action_required", learnerId }));
  });

  it("does not flag a learner who already has an active passkey", async () => {
    activeApp(learnerId);
    seedPasskey(learnerId, "active");
    const result = await composeParentAttention(parentId, now);
    expect(result.items.filter((i) => i.category === "learner_setup")).toEqual([]);
  });

  it("does not flag a learner with zero current apps, even without a passkey", async () => {
    const result = await composeParentAttention(parentId, now);
    expect(result.items.filter((i) => i.category === "learner_setup")).toEqual([]);
  });

  it("only produces one learner_setup item even with multiple current apps missing a passkey", async () => {
    activeApp(learnerId);
    activeApp(learnerId);
    const result = await composeParentAttention(parentId, now);
    expect(result.items.filter((i) => i.category === "learner_setup")).toHaveLength(1);
  });
});

describe("composeParentAttention — service_status", () => {
  it("surfaces a current app's temporarily_unavailable state", async () => {
    const appId = activeApp(learnerId);
    seedAvailability(appId, "temporarily_unavailable", "Back soon.");
    const result = await composeParentAttention(parentId, now);
    expect(result.items).toContainEqual(expect.objectContaining({ category: "service_status", appId, message: "Back soon." }));
  });

  it("produces no service_status item when availability is unknown (no row seeded)", async () => {
    activeApp(learnerId);
    const result = await composeParentAttention(parentId, now);
    expect(result.items.filter((i) => i.category === "service_status")).toEqual([]);
  });
});

describe("composeParentAttention — access (security suspension)", () => {
  it("shows a safe generic attention item with no CTA route for a suspended_security app", async () => {
    const appId = suspendedSecurityApp(learnerId);
    const result = await composeParentAttention(parentId, now);
    const item = result.items.find((i) => i.category === "access" && i.appId === appId);
    expect(item).toMatchObject({ severity: "attention", route: null });
    expect(item!.message).not.toMatch(/fraud/i);
  });
});

describe("composeParentAttention — learning_cadence", () => {
  it("reuses EG-006's mid-window timing/feasibility rules and never writes/sends", async () => {
    const appId = activeApp(learnerId);
    getDb().prepare(`insert into learner_app_week_usage
      (learner_id,app_id,week_key,week_timezone,normal_sessions_started,standard_sessions_funded,version,updated_at)
      values(?,?,?,'Asia/Kolkata',0,0,1,?)`)
      .run(learnerId, appId, "2026-W33", now.toISOString());
    const before = (getDb().prepare("select count(*) as n from learning_reminder_batches").get() as { n: number }).n;
    const result = await composeParentAttention(parentId, now);
    const after = (getDb().prepare("select count(*) as n from learning_reminder_batches").get() as { n: number }).n;
    expect(after).toBe(before);
    expect(result.items).toContainEqual(expect.objectContaining({ category: "learning_cadence", severity: "attention", appId }));
  });

  it("never marks cadence action_required", async () => {
    const appId = activeApp(learnerId);
    getDb().prepare(`insert into learner_app_week_usage
      (learner_id,app_id,week_key,week_timezone,normal_sessions_started,standard_sessions_funded,version,updated_at)
      values(?,?,?,'Asia/Kolkata',0,0,1,?)`)
      .run(learnerId, appId, "2026-W33", now.toISOString());
    const result = await composeParentAttention(parentId, now);
    const cadence = result.items.filter((i) => i.category === "learning_cadence");
    expect(cadence.every((i) => i.severity === "attention")).toBe(true);
  });
});

describe("composeParentAttention — dedupe, sort, ownership, side effects", () => {
  it("never returns two items with the same sourceKey", async () => {
    activeApp(learnerId);
    seedSubscription({ learner: learnerId, paymentState: "renewal_failed" });
    const result = await composeParentAttention(parentId, now);
    const keys = result.items.map((i) => i.sourceKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("sorts action_required items before attention before info", async () => {
    activeApp(learnerId); // -> learner_setup action_required
    seedSubscription({ learner: learnerId, cancelAtPeriodEnd: true }); // -> billing attention
    const result = await composeParentAttention(parentId, now);
    const severities = result.items.map((i) => i.severity);
    const firstAttentionIdx = severities.indexOf("attention");
    const lastActionRequiredIdx = severities.lastIndexOf("action_required");
    if (firstAttentionIdx !== -1 && lastActionRequiredIdx !== -1) {
      expect(lastActionRequiredIdx).toBeLessThan(firstAttentionIdx);
    }
  });

  it("never surfaces another parent's learner", async () => {
    const { user: otherParent } = await sqliteAuthAdapter.signUp(`pd003-other-${randomUUID()}@example.com`, "CorrectHorse1!");
    const otherLearner = (await createLearner(otherParent.id, { displayName: "Other Kid", dateOfBirth: "2018-01-01",
      idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
    activeApp(otherLearner, otherParent.id);
    const result = await composeParentAttention(parentId, now);
    expect(result.items.every((i) => i.learnerId !== otherLearner)).toBe(true);
  });

  it("is a pure read — writes nothing to the database", async () => {
    activeApp(learnerId);
    seedSubscription({ learner: learnerId, paymentState: "renewal_failed" });
    const tables = ["learner_app_effective_entitlements", "subscriptions", "app_launch_availability",
      "learner_passkey_credentials", "learning_reminder_batches"];
    const before = tables.map((t) => (getDb().prepare(`select count(*) as n from ${t}`).get() as { n: number }).n);
    await composeParentAttention(parentId, now);
    const after = tables.map((t) => (getDb().prepare(`select count(*) as n from ${t}`).get() as { n: number }).n);
    expect(after).toEqual(before);
  });

  it("is deterministic — composing twice with the same inputs yields the same version", async () => {
    activeApp(learnerId);
    const first = await composeParentAttention(parentId, now);
    const second = await composeParentAttention(parentId, now);
    expect(second.version).toBe(first.version);
  });
});

describe("composeParentAttentionBadge", () => {
  it("summarizes counts (including infoCount) and a bounded preview matching the full composition", async () => {
    activeApp(learnerId); // learner_setup action_required
    seedSubscription({ learner: learnerId, cancelAtPeriodEnd: true }); // billing attention
    const full = await composeParentAttention(parentId, now);
    const badge = await composeParentAttentionBadge(parentId, now);
    expect(badge.version).toBe(full.version);
    expect(badge.actionRequiredCount).toBe(full.items.filter((i) => i.severity === "action_required").length);
    expect(badge.attentionCount).toBe(full.items.filter((i) => i.severity === "attention").length);
    expect(badge.infoCount).toBe(full.items.filter((i) => i.severity === "info").length);
    expect(badge.hasItems).toBe(full.items.length > 0);
    expect(badge.preview).toEqual(full.items.slice(0, 3));
  });
});

describe("composeParentAttention — nextRecheckAt (AT-PD-003-40)", () => {
  it("returns the earliest upcoming grace-window boundary across billing items", async () => {
    seedSubscription({ learner: learnerId, paymentState: "past_due_grace", graceEndsAt: "2026-08-20T00:00:00.000Z" });
    const result = await composeParentAttention(parentId, now);
    expect(result.nextRecheckAt).toBe("2026-08-20T00:00:00.000Z");
  });

  it("is null when there is no known future boundary", async () => {
    seedSubscription({ learner: learnerId });
    const result = await composeParentAttention(parentId, now);
    expect(result.nextRecheckAt).toBeNull();
  });
});

describe("composeParentAttentionList — API-PD-004 (PD3-G03/G04/G09)", () => {
  it("AT-PD-003-35: applies learnerId/category/severity filters after canonical composition, never widening scope", async () => {
    activeApp(learnerId); // learner_setup action_required
    seedSubscription({ learner: learnerId, cancelAtPeriodEnd: true }); // billing attention
    const filtered = await composeParentAttentionList(parentId, { category: "billing" }, now);
    expect(filtered.items.every((item) => item.category === "billing")).toBe(true);
    expect(filtered.summary.actionRequiredCount).toBe(0);
  });

  it("AT-PD-003-44: a foreign learnerId yields an empty page, never a leak", async () => {
    activeApp(learnerId);
    const result = await composeParentAttentionList(parentId, { learnerId: "someone-elses-learner" }, now);
    expect(result.items).toEqual([]);
  });

  it("PD3-G04: deterministic cursor pagination — repeated calls with the same cursor return stable, non-overlapping pages", async () => {
    for (let i = 0; i < 3; i += 1) activeApp(learnerId, parentId, "Learning App " + i); // 3x current apps dedupe to 1 learner_setup item
    seedSubscription({ learner: learnerId, paymentState: "renewal_failed" });
    seedSubscription({ learner: learnerId, cancelAtPeriodEnd: true });
    const page1 = await composeParentAttentionList(parentId, { limit: "1" }, now);
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const page1Again = await composeParentAttentionList(parentId, { limit: "1" }, now);
    expect(page1Again.items).toEqual(page1.items);
    const page2 = await composeParentAttentionList(parentId, { limit: "1", cursor: page1.nextCursor! }, now);
    expect(page2.items[0]?.sourceKey).not.toBe(page1.items[0]?.sourceKey);
  });

  it("PD3-G09: rejects an invalid category/severity/cursor/limit with a typed request error", async () => {
    await expect(composeParentAttentionList(parentId, { category: "bogus" }, now)).rejects.toThrow(ParentAttentionRequestError);
    await expect(composeParentAttentionList(parentId, { severity: "bogus" }, now)).rejects.toThrow(ParentAttentionRequestError);
    await expect(composeParentAttentionList(parentId, { cursor: "not-a-number" }, now)).rejects.toThrow(ParentAttentionRequestError);
    await expect(composeParentAttentionList(parentId, { cursor: "-1" }, now)).rejects.toThrow(ParentAttentionRequestError);
    await expect(composeParentAttentionList(parentId, { limit: "0" }, now)).rejects.toThrow(ParentAttentionRequestError);
    await expect(composeParentAttentionList(parentId, { limit: "51" }, now)).rejects.toThrow(ParentAttentionRequestError);
  });

  it("carries the same attentionVersion/summary policy as the full composition", async () => {
    activeApp(learnerId);
    const full = await composeParentAttention(parentId, now);
    const list = await composeParentAttentionList(parentId, {}, now);
    expect(list.version).toBe(full.version);
    expect(list.nextRecheckAt).toBe(full.nextRecheckAt);
  });
});

describe("composeParentAttentionSummary — API-PD-005 (PD3-G01/G02/G07)", () => {
  it("scopes to one learner when learnerId is given", async () => {
    activeApp(learnerId);
    const summary = await composeParentAttentionSummary(parentId, { learnerId }, now);
    expect(summary.actionRequiredCount).toBeGreaterThan(0);
    const otherSummary = await composeParentAttentionSummary(parentId, { learnerId: "nonexistent" }, now);
    expect(otherSummary.actionRequiredCount).toBe(0);
    expect(otherSummary.hasItems).toBe(false);
  });

  it("PD3-G07: bounds the preview to a caller-controlled limit up to 5", async () => {
    const summary = await composeParentAttentionSummary(parentId, { limit: "5" }, now);
    expect(summary.preview.length).toBeLessThanOrEqual(5);
  });

  it("rejects a limit above 5 or below 1", async () => {
    await expect(composeParentAttentionSummary(parentId, { limit: "6" }, now)).rejects.toThrow(ParentAttentionRequestError);
    await expect(composeParentAttentionSummary(parentId, { limit: "0" }, now)).rejects.toThrow(ParentAttentionRequestError);
  });

  it("uses the exact same composition/version as composeParentAttentionBadge with no filters", async () => {
    activeApp(learnerId);
    const badge = await composeParentAttentionBadge(parentId, now);
    const summary = await composeParentAttentionSummary(parentId, {}, now);
    expect(summary).toEqual(badge);
  });
});
