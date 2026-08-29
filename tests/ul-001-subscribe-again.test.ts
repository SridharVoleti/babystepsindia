import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { applyPaidCycle } from "@/lib/entitlement-cycle/service";
import { defineProductVersion } from "@/lib/billing/bi001-service";
import { resolveSubscribeAgainContinuation } from "@/lib/learner-home/subscribe-again";
import { LearnerHomeError } from "@/lib/learner-home/past-apps";

const environment = "production";
const now = new Date("2026-08-15T00:00:00.000Z");
let parentId: string;
let learnerId: string;

function seedApp(appId: string) {
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, appId);
}

function seedCycle(appId: string, periodStart: string, periodEnd: string) {
  return applyPaidCycle({
    paidCycleId: `cycle-${appId}`, eventId: `event-${appId}`, eventVersion: 1, subscriptionId: `sub-${appId}`,
    purchaserParentId: parentId, assignedLearnerId: learnerId, productId: `product-cycle-${appId}`, productVersion: 1,
    appIds: [appId], periodStart, periodEnd, billingAnchor: periodStart.slice(0, 10), environment, now: new Date(periodStart),
  });
}

function endedApp(appId: string) {
  seedApp(appId);
  seedCycle(appId, "2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
}

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`ul001-subscribe-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
});

describe("resolveSubscribeAgainContinuation", () => {
  it("rejects when the app is still currently accessible", async () => {
    seedApp("app-live");
    seedCycle("app-live", "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    const result = await resolveSubscribeAgainContinuation(parentId, learnerId, "app-live", now);
    expect(result).toEqual({ eligible: false, reason: "app_still_accessible" });
  });

  it("rejects when no current product includes the app", async () => {
    endedApp("app-unsold");
    const result = await resolveSubscribeAgainContinuation(parentId, learnerId, "app-unsold", now);
    expect(result).toEqual({ eligible: false, reason: "not_currently_sold" });
  });

  it("rejects when more than one current product includes the app", async () => {
    endedApp("app-dual");
    await defineProductVersion({ id: "product-dual-a", slug: "dual-a", name: "Dual A", subdomain: "duala.example.test",
      planReference: "plan-a", priceInr: 199, productType: "individual_app", version: 1, appIds: ["app-dual"] });
    seedApp("app-dual-2");
    await defineProductVersion({ id: "product-dual-b", slug: "dual-b", name: "Dual B", subdomain: "dualb.example.test",
      planReference: "plan-b", priceInr: 299, productType: "bundle", version: 1, appIds: ["app-dual", "app-dual-2"] });
    const result = await resolveSubscribeAgainContinuation(parentId, learnerId, "app-dual", now);
    expect(result).toEqual({ eligible: false, reason: "multiple_current_products" });
  });

  it("rejects on overlap with a currently active subscription covering the same app", async () => {
    endedApp("app-overlap");
    await defineProductVersion({ id: "product-overlap", slug: "overlap-monthly", name: "Overlap Monthly",
      subdomain: "overlap.example.test", planReference: "plan-overlap", priceInr: 199, productType: "individual_app",
      version: 1, appIds: ["app-overlap"] });
    getDb().prepare(`insert into subscriptions(id,user_id,type,assigned_learner_id,purchaser_parent_id,product_id,
      product_version,status,razorpay_subscription_id,current_period_end,created_at,updated_at)
      values(?,?,'single',?,?,?,?,?,?,?,?,?)`)
      .run("sub-overlap-live", parentId, learnerId, parentId, "product-overlap", 1, "active",
        "razorpay-sub-overlap-live", new Date(now.getTime() + 30 * 86_400_000).toISOString(), now.toISOString(), now.toISOString());
    const result = await resolveSubscribeAgainContinuation(parentId, learnerId, "app-overlap", now);
    expect(result).toEqual({ eligible: false, reason: "overlap" });
  });

  it("returns the exact current product/version on the happy path and writes no checkout_intents row", async () => {
    endedApp("app-resub");
    await defineProductVersion({ id: "product-resub", slug: "resub-monthly", name: "Resub Monthly",
      subdomain: "resub.example.test", planReference: "plan-resub", priceInr: 199, productType: "individual_app",
      version: 1, appIds: ["app-resub"] });
    const before = (getDb().prepare("select count(*) as n from checkout_intents").get() as { n: number }).n;
    const result = await resolveSubscribeAgainContinuation(parentId, learnerId, "app-resub", now);
    expect(result).toEqual({ eligible: true, productId: "product-resub", productSlug: "resub-monthly",
      productVersion: 1, learnerId });
    const after = (getDb().prepare("select count(*) as n from checkout_intents").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("throws RESOURCE_NOT_FOUND for a learner not owned by this parent", async () => {
    endedApp("app-foreign");
    const other = await sqliteAuthAdapter.signUp(`ul001-subscribe-other-${randomUUID()}@example.com`, "CorrectHorse1!");
    await expect(resolveSubscribeAgainContinuation(other.user.id, learnerId, "app-foreign", now)).rejects.toThrow(LearnerHomeError);
  });
});
