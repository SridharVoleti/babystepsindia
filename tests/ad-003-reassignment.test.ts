// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { createSupportCase, resolveCustomer } from "@/lib/support-cases/service";
import { reassignSubscriptionViaCase } from "@/lib/support-cases/billing";
import { BillingAssignmentError } from "@/lib/billing/errors";

let parentId: string;
let parentEmail: string;
let sourceLearnerId: string;
let targetLearnerId: string;
let subscriptionId: string;
let billingStaff: ReturnType<typeof seedStaffSession>;
let caseId: string;

const REASON = "Parent asked to move the subscription to their other child.";

function seedMinimalSubscription(id: string, purchaserParentId: string, assignedLearnerId: string) {
  const db = getDb();
  const { id: productId, version: productVersion } = db.prepare("select id, version from products limit 1").get() as
    { id: string; version: number };
  // BI-001's overlap/eligibility checks resolve the product's app set via
  // product_version_apps — not synced automatically like the products
  // catalog itself, so a real reassignment test needs at least one mapping.
  const appId = `app-${randomUUID()}`;
  db.prepare(
    `insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
     values(?,?,?,'Test app','icon','learning','team','active')`,
  ).run(appId, appId, "Test App");
  db.prepare("insert into product_version_apps(product_id,product_version,app_id) values(?,?,?)")
    .run(productId, productVersion, appId);
  db.prepare(
    `insert into subscriptions(id,user_id,type,product_id,product_version,purchaser_parent_id,assigned_learner_id,status,
     razorpay_subscription_id,current_period_end) values(?,?,'single',?,?,?,?,'active',?,?)`,
  ).run(id, purchaserParentId, productId, productVersion, purchaserParentId, assignedLearnerId, `rzp_sub_${randomUUID()}`,
    new Date(Date.now() + 30 * 86_400_000).toISOString());
}

beforeEach(async () => {
  useInMemoryDb();
  parentEmail = `parent-${randomUUID()}@example.com`;
  const { user } = await sqliteAuthAdapter.signUp(parentEmail, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
  sourceLearnerId = createLearner(parentId, { displayName: "Source Kid", dateOfBirth: "2018-01-01", idempotencyKey: randomUUID() }, "2026-08-16").learner.id;
  targetLearnerId = createLearner(parentId, { displayName: "Target Kid", dateOfBirth: "2019-01-01", idempotencyKey: randomUUID() }, "2026-08-16").learner.id;
  subscriptionId = randomUUID();
  seedMinimalSubscription(subscriptionId, parentId, sourceLearnerId);
  billingStaff = seedStaffSession(["billing_administrator"]);
  const resolved = resolveCustomer(billingStaff, { identifierType: "subscription_ref", identifierValue: subscriptionId, reason: REASON });
  caseId = createSupportCase(billingStaff, { receiptId: resolved.receiptId, category: "subscription_assignment", reason: REASON, idempotencyKey: randomUUID() }).caseId;
});

describe("AD-003 reassignSubscriptionViaCase (AT-AD-003-17/18/19/20/21)", () => {
  it("delegates to BI-001 and reassigns the subscription immediately when unused", () => {
    const subVersion = (getDb().prepare("select version from subscriptions where id=?").get(subscriptionId) as { version: number }).version;
    const result = reassignSubscriptionViaCase(billingStaff, caseId, {
      subscriptionId, targetLearnerId, reasonCode: "parent_request", effectiveMode: "immediate_if_unused",
      expectedSubscriptionVersion: subVersion, idempotencyKey: randomUUID(),
    });
    expect(result.status).toBe("executed");
    const updated = getDb().prepare("select assigned_learner_id from subscriptions where id=?").get(subscriptionId) as
      { assigned_learner_id: string };
    expect(updated.assigned_learner_id).toBe(targetLearnerId);
  });

  it("AT-21: appends a support_case_activity row recording the reassignment", () => {
    const subVersion = (getDb().prepare("select version from subscriptions where id=?").get(subscriptionId) as { version: number }).version;
    reassignSubscriptionViaCase(billingStaff, caseId, {
      subscriptionId, targetLearnerId, reasonCode: "parent_request", effectiveMode: "immediate_if_unused",
      expectedSubscriptionVersion: subVersion, idempotencyKey: randomUUID(),
    });
    const activity = getDb().prepare(
      "select underlying_role from support_case_activity where case_id=? and canonical_action='admin.support.billing.reassign'",
    ).get(caseId) as { underlying_role: string };
    expect(activity.underlying_role).toBe("billing_administrator");
  });

  it("AT-20: a foreign (non-owned) target learner is rejected — server revalidates, never trusts the caller", async () => {
    const { user: otherParent } = await sqliteAuthAdapter.signUp(`foreign-${randomUUID()}@example.com`, "CorrectHorse1!");
    const foreignLearnerId = createLearner(otherParent.id, { displayName: "Foreign Kid", dateOfBirth: "2018-01-01", idempotencyKey: randomUUID() }, "2026-08-16").learner.id;
    const subVersion = (getDb().prepare("select version from subscriptions where id=?").get(subscriptionId) as { version: number }).version;
    expect(() => reassignSubscriptionViaCase(billingStaff, caseId, {
      subscriptionId, targetLearnerId: foreignLearnerId, reasonCode: "parent_request", effectiveMode: "immediate_if_unused",
      expectedSubscriptionVersion: subVersion, idempotencyKey: randomUUID(),
    })).toThrow(BillingAssignmentError);
  });

  it("a stale expectedSubscriptionVersion is rejected as a version conflict, never silently overwritten", () => {
    expect(() => reassignSubscriptionViaCase(billingStaff, caseId, {
      subscriptionId, targetLearnerId, reasonCode: "parent_request", effectiveMode: "immediate_if_unused",
      expectedSubscriptionVersion: 999, idempotencyKey: randomUUID(),
    })).toThrow(BillingAssignmentError);
  });

  it("AT-18/19: reassignment never transfers progress or credits — only the assignment itself changes", () => {
    const beforeProgress = (getDb().prepare("select count(*) n from learner_app_progress where learner_id=?").get(sourceLearnerId) as { n: number }).n;
    const subVersion = (getDb().prepare("select version from subscriptions where id=?").get(subscriptionId) as { version: number }).version;
    reassignSubscriptionViaCase(billingStaff, caseId, {
      subscriptionId, targetLearnerId, reasonCode: "parent_request", effectiveMode: "immediate_if_unused",
      expectedSubscriptionVersion: subVersion, idempotencyKey: randomUUID(),
    });
    const afterProgress = (getDb().prepare("select count(*) n from learner_app_progress where learner_id=?").get(sourceLearnerId) as { n: number }).n;
    expect(afterProgress).toBe(beforeProgress);
    expect((getDb().prepare("select count(*) n from learner_app_progress where learner_id=?").get(targetLearnerId) as { n: number }).n).toBe(0);
  });

  it("a closed case cannot authorize a new reassignment", () => {
    getDb().prepare("update support_cases set status='closed' where id=?").run(caseId);
    const subVersion = (getDb().prepare("select version from subscriptions where id=?").get(subscriptionId) as { version: number }).version;
    expect(() => reassignSubscriptionViaCase(billingStaff, caseId, {
      subscriptionId, targetLearnerId, reasonCode: "parent_request", effectiveMode: "immediate_if_unused",
      expectedSubscriptionVersion: subVersion, idempotencyKey: randomUUID(),
    })).toThrow();
  });
});
