import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { applyPaidCycle } from "@/lib/entitlement-cycle/service";
import { defineProductVersion } from "@/lib/billing/bi001-service";
import { listPastApps, LearnerHomeError } from "@/lib/learner-home/past-apps";

const environment = "production";
let parentId: string;
let learnerId: string;

function seedApp(appId: string, displayName = appId) {
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, displayName);
}

function seedCycle(appId: string, periodStart: string, periodEnd: string, paidCycleId = `cycle-${appId}`) {
  return applyPaidCycle({
    paidCycleId, eventId: `event-${paidCycleId}`, eventVersion: 1, subscriptionId: `sub-${appId}`,
    purchaserParentId: parentId, assignedLearnerId: learnerId, productId: `product-${appId}`, productVersion: 1,
    appIds: [appId], periodStart, periodEnd, billingAnchor: periodStart.slice(0, 10), environment, now: new Date(periodStart),
  });
}

// An ended entitlement — a cycle whose period is entirely in the past
// relative to `now` below.
function endedApp(appId: string, displayName = appId) {
  seedApp(appId, displayName);
  seedCycle(appId, "2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
}

const now = new Date("2026-08-15T00:00:00.000Z");

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`ul001-past-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
});

describe("listPastApps — membership", () => {
  it("returns nothing for a learner with no entitlement history", async () => {
    expect(await listPastApps(parentId, learnerId, now)).toEqual([]);
  });

  it("excludes an app the learner still has active access to, even alongside an older ended period (rule 34)", async () => {
    seedApp("app-both");
    seedCycle("app-both", "2026-06-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z", "cycle-both-1");
    seedCycle("app-both", "2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", "cycle-both-2");
    expect(await listPastApps(parentId, learnerId, now)).toEqual([]);
  });

  it("includes an ended app exactly once (rule 32-33)", async () => {
    endedApp("app-ended", "Ended App");
    const past = await listPastApps(parentId, learnerId, now);
    expect(past).toHaveLength(1);
    expect(past[0]).toMatchObject({ appId: "app-ended", appName: "Ended App", accessEndedDate: "2026-07-01T00:00:00.000Z" });
  });

  it("throws RESOURCE_NOT_FOUND for a learner not owned by this parent", async () => {
    const other = await sqliteAuthAdapter.signUp(`ul001-past-other-${randomUUID()}@example.com`, "CorrectHorse1!");
    await expect(listPastApps(other.user.id, learnerId, now)).rejects.toThrow(LearnerHomeError);
  });
});

describe("listPastApps — preserved summary", () => {
  it("shows the last safe summary when present", async () => {
    endedApp("app-sum");
    getDb().prepare(`insert into learner_app_progress(learner_id,app_id,progress_summary_json) values(?,?,?)`)
      .run(learnerId, "app-sum", JSON.stringify({ currentLevel: "L4", efficiencyStars: 5, milestone: "Finished unit 1", nextDestination: "L5" }));
    const past = await listPastApps(parentId, learnerId, now);
    expect(past[0].lastSafeSummary).toEqual({ currentLevel: "L4", efficiencyStars: 5, milestone: "Finished unit 1", nextDestination: "L5" });
    expect(past[0].summaryUnavailableReason).toBeNull();
  });

  it("shows a neutral unavailable reason with no invented values when no safe summary exists (rule 56)", async () => {
    endedApp("app-nosum");
    const past = await listPastApps(parentId, learnerId, now);
    expect(past[0].lastSafeSummary).toBeNull();
    expect(past[0].summaryUnavailableReason).toBe("preserved_progress_unavailable");
  });
});

describe("listPastApps — subscribe again eligibility", () => {
  it("offers subscribe-again when a current single product includes the app and there is no overlap", async () => {
    endedApp("app-resub");
    await defineProductVersion({ id: "product-resub", slug: "resub-monthly", name: "Resub Monthly",
      subdomain: "resub.example.test", planReference: "plan-resub", priceInr: 199, productType: "individual_app",
      version: 1, appIds: ["app-resub"] });
    const past = await listPastApps(parentId, learnerId, now);
    expect(past[0].subscribeAgain).toEqual({ offered: true, productId: "product-resub", productSlug: "resub-monthly", productVersion: 1 });
  });

  it("marks not_currently_sold when no active product currently includes the app", async () => {
    endedApp("app-unsold");
    const past = await listPastApps(parentId, learnerId, now);
    expect(past[0].subscribeAgain).toEqual({ offered: false, reason: "not_currently_sold" });
  });

  it("fails closed with multiple_current_products when more than one current product includes the app", async () => {
    endedApp("app-dual");
    await defineProductVersion({ id: "product-dual-a", slug: "dual-a", name: "Dual A", subdomain: "duala.example.test",
      planReference: "plan-a", priceInr: 199, productType: "individual_app", version: 1, appIds: ["app-dual"] });
    seedApp("app-dual-2");
    await defineProductVersion({ id: "product-dual-b", slug: "dual-b", name: "Dual B", subdomain: "dualb.example.test",
      planReference: "plan-b", priceInr: 299, productType: "bundle", version: 1, appIds: ["app-dual", "app-dual-2"] });
    const past = await listPastApps(parentId, learnerId, now);
    expect(past.find((c) => c.appId === "app-dual")!.subscribeAgain).toEqual({ offered: false, reason: "multiple_current_products" });
  });

  it("marks overlap when the learner already has current access via a different product covering the same app", async () => {
    endedApp("app-overlap");
    await defineProductVersion({ id: "product-overlap", slug: "overlap-monthly", name: "Overlap Monthly",
      subdomain: "overlap.example.test", planReference: "plan-overlap", priceInr: 199, productType: "individual_app",
      version: 1, appIds: ["app-overlap"] });
    // The learner already has a live, currently-active subscription covering this same app via a different product.
    getDb().prepare(`insert into subscriptions(id,user_id,type,assigned_learner_id,purchaser_parent_id,product_id,
      product_version,status,razorpay_subscription_id,current_period_end,created_at,updated_at)
      values(?,?,'single',?,?,?,?,?,?,?,?,?)`)
      .run("sub-overlap-live", parentId, learnerId, parentId, "product-overlap", 1, "active",
        "razorpay-sub-overlap-live", new Date(now.getTime() + 30 * 86_400_000).toISOString(),
        now.toISOString(), now.toISOString());
    const past = await listPastApps(parentId, learnerId, now);
    expect(past[0].subscribeAgain).toEqual({ offered: false, reason: "overlap" });
  });
});

describe("listPastApps — side effects", () => {
  it("writes nothing (rule: idempotent, side-effect-free reads)", async () => {
    endedApp("app-readonly");
    const before = (getDb().prepare("select count(*) as n from progress_integrity_validation_receipts").get() as { n: number }).n;
    await listPastApps(parentId, learnerId, now);
    const after = (getDb().prepare("select count(*) as n from progress_integrity_validation_receipts").get() as { n: number }).n;
    expect(after).toBe(before);
  });
});
