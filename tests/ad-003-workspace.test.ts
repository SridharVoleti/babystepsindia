// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { createSupportCase, resolveCustomer } from "@/lib/support-cases/service";
import { composeBillingWorkspace, getReassignmentEligibility, getRefundEligibility } from "@/lib/support-cases/billing";
import { SupportCaseError } from "@/lib/support-cases/contracts";
import { roleHasCapability } from "@/lib/staff-identity/roles";

let parentId: string;
let parentEmail: string;
let learnerId: string;
let subscriptionId: string;
let supportStaff: ReturnType<typeof seedStaffSession>;
let billingStaff: ReturnType<typeof seedStaffSession>;

const REASON = "Parent is asking why their renewal amount looks different this month.";

function seedMinimalSubscription(id: string, purchaserParentId: string, assignedLearnerId: string) {
  const db = getDb();
  const { id: productId } = db.prepare("select id from products limit 1").get() as { id: string };
  db.prepare(
    `insert into subscriptions(id,user_id,type,product_id,purchaser_parent_id,assigned_learner_id,status,
     razorpay_subscription_id,current_period_end) values(?,?,'single',?,?,?,'active',?,?)`,
  ).run(id, purchaserParentId, productId, purchaserParentId, assignedLearnerId, `rzp_sub_${randomUUID()}`,
    new Date(Date.now() + 30 * 86_400_000).toISOString());
}

function makeCaseForSubscription(staff: ReturnType<typeof seedStaffSession>) {
  const resolved = resolveCustomer(staff, { identifierType: "subscription_ref", identifierValue: subscriptionId, reason: REASON });
  return createSupportCase(staff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() }).caseId;
}

beforeEach(async () => {
  useInMemoryDb();
  parentEmail = `parent-${randomUUID()}@example.com`;
  const { user } = await sqliteAuthAdapter.signUp(parentEmail, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
  learnerId = createLearner(parentId, { displayName: "Kid A", dateOfBirth: "2018-01-01", idempotencyKey: randomUUID() }, "2026-08-16").learner.id;
  subscriptionId = randomUUID();
  seedMinimalSubscription(subscriptionId, parentId, learnerId);
  supportStaff = seedStaffSession(["support_agent"]);
  billingStaff = seedStaffSession(["billing_administrator"]);
});

describe("AD-003 composeBillingWorkspace (AT-AD-003-01/02/03/05/06/07/08/09)", () => {
  it("AT-01: requires an active case — no caseId means no workspace", () => {
    expect(() => composeBillingWorkspace(billingStaff, randomUUID())).toThrow(SupportCaseError);
  });

  it("AT-02: a case bound to a DIFFERENT subscription cannot be used to open this one's workspace", () => {
    const otherSubscriptionId = randomUUID();
    seedMinimalSubscription(otherSubscriptionId, parentId, learnerId);
    const resolved = resolveCustomer(billingStaff, { identifierType: "subscription_ref", identifierValue: otherSubscriptionId, reason: REASON });
    const caseId = createSupportCase(billingStaff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() }).caseId;
    expect(() => composeBillingWorkspace(billingStaff, caseId, subscriptionId)).toThrow(SupportCaseError);
  });

  it("AT-03: a case whose bound parent does not own the target subscription is denied", async () => {
    const { user: otherParent } = await sqliteAuthAdapter.signUp(`other-${randomUUID()}@example.com`, "CorrectHorse1!");
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", otherParent.id);
    const otherResolved = resolveCustomer(billingStaff, { identifierType: "email", identifierValue: otherParent.email, reason: REASON });
    const caseId = createSupportCase(billingStaff, { receiptId: otherResolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() }).caseId;
    expect(() => composeBillingWorkspace(billingStaff, caseId, subscriptionId)).toThrow(SupportCaseError);
  });

  it("AT-05/06: Support-only staff has no Billing workspace capability; billing_administrator does", () => {
    expect(roleHasCapability(supportStaff.roleKeys, "admin.support.billing.workspace.read")).toBe(false);
    expect(roleHasCapability(billingStaff.roleKeys, "admin.support.billing.workspace.read")).toBe(true);
    const caseId = makeCaseForSubscription(billingStaff);
    const workspace = composeBillingWorkspace(billingStaff, caseId, subscriptionId);
    expect(workspace.subscription.id).toBe(subscriptionId);
  });

  it("a Super Admin (all four roles) can open the workspace because it explicitly holds Billing Administrator", () => {
    const superAdmin = seedStaffSession(["support_agent", "billing_administrator", "operations_administrator", "platform_administrator"]);
    expect(roleHasCapability(superAdmin.roleKeys, "admin.support.billing.workspace.read")).toBe(true);
    const caseId = makeCaseForSubscription(superAdmin);
    const workspace = composeBillingWorkspace(superAdmin, caseId, subscriptionId);
    expect(workspace.subscription.id).toBe(subscriptionId);
  });

  it("holding only Platform Administrator (no Billing) is denied", () => {
    const platformOnly = seedStaffSession(["platform_administrator"]);
    expect(roleHasCapability(platformOnly.roleKeys, "admin.support.billing.workspace.read")).toBe(false);
    expect(roleHasCapability(platformOnly.roleKeys, "admin.support.billing.reassign")).toBe(false);
  });

  it("AT-07: opening the workspace mutates nothing", () => {
    const caseId = makeCaseForSubscription(billingStaff);
    const before = getDb().prepare("select version from subscriptions where id=?").get(subscriptionId) as { version: number };
    composeBillingWorkspace(billingStaff, caseId, subscriptionId);
    composeBillingWorkspace(billingStaff, caseId, subscriptionId);
    const after = getDb().prepare("select version from subscriptions where id=?").get(subscriptionId) as { version: number };
    expect(after.version).toBe(before.version);
  });

  it("AT-08/09: the workspace exposes no raw learner progress, password hash or provider secrets", () => {
    const caseId = makeCaseForSubscription(billingStaff);
    const workspace = composeBillingWorkspace(billingStaff, caseId, subscriptionId);
    const serialized = JSON.stringify(workspace);
    expect(serialized).not.toMatch(/password_hash|passkey|razorpay_subscription_id|provider_mandate/i);
  });

  it("a closed case cannot open a billing workspace", () => {
    const caseId = makeCaseForSubscription(billingStaff);
    getDb().prepare("update support_cases set status='closed' where id=?").run(caseId);
    expect(() => composeBillingWorkspace(billingStaff, caseId, subscriptionId)).toThrow(SupportCaseError);
  });
});

describe("AD-003 eligibility endpoints (AT-AD-003-13/22)", () => {
  it("AT-13: reassignment eligibility lists the purchaser's other owned learners", () => {
    const otherLearnerId = createLearner(parentId, { displayName: "Kid B", dateOfBirth: "2019-01-01", idempotencyKey: randomUUID() }, "2026-08-16").learner.id;
    const caseId = makeCaseForSubscription(billingStaff);
    const eligibility = getReassignmentEligibility(billingStaff, caseId, subscriptionId);
    expect(eligibility.eligibleTargets.map((t) => t.learnerId)).toContain(otherLearnerId);
    expect(eligibility.eligibleTargets.map((t) => t.learnerId)).not.toContain(learnerId);
  });

  it("AT-22: refund eligibility reports the current refundable amount", () => {
    const caseId = makeCaseForSubscription(billingStaff);
    const eligibility = getRefundEligibility(billingStaff, caseId, subscriptionId);
    expect(eligibility.subscriptionId).toBe(subscriptionId);
    expect(eligibility.maxRefundableAmount).toBeGreaterThanOrEqual(0);
  });
});
