// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStaffSession: vi.fn(), hasLiveReauthReceipt: vi.fn() }));
vi.mock("@/lib/staff-identity/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staff-identity/session")>()),
  getStaffSession: mocks.getStaffSession,
}));
vi.mock("@/lib/staff-identity/reauth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staff-identity/reauth-service")>()),
  hasLiveReauthReceipt: mocks.hasLiveReauthReceipt,
}));

import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { createSupportCase, resolveCustomer } from "@/lib/support-cases/service";
import { GET as getWorkspace } from "@/app/v1/admin/support/cases/[caseId]/billing/route";
import { POST as postReassign } from "@/app/v1/admin/support/cases/[caseId]/billing/reassign-subscription/route";
import { POST as postRefund } from "@/app/v1/admin/support/cases/[caseId]/billing/refunds/route";

let parentId: string;
let parentEmail: string;
let learnerId: string;
let subscriptionId: string;
let caseId: string;

const REASON = "Investigating a subscription billing discrepancy the parent reported.";

function seedMinimalSubscription(id: string, purchaserParentId: string, assignedLearnerId: string) {
  const db = getDb();
  const { id: productId, version: productVersion } = db.prepare("select id, version from products limit 1").get() as
    { id: string; version: number };
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

function asStaff(roleKeys: Parameters<typeof seedStaffSession>[0]) {
  const session = seedStaffSession(roleKeys);
  mocks.getStaffSession.mockResolvedValue(session);
  return session;
}

function jsonRequest(url: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}

beforeEach(async () => {
  useInMemoryDb();
  mocks.hasLiveReauthReceipt.mockReturnValue(false);
  parentEmail = `parent-${randomUUID()}@example.com`;
  const { user } = await sqliteAuthAdapter.signUp(parentEmail, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
  learnerId = createLearner(parentId, { displayName: "Kid", dateOfBirth: "2018-01-01", idempotencyKey: randomUUID() }, "2026-08-16").learner.id;
  subscriptionId = randomUUID();
  seedMinimalSubscription(subscriptionId, parentId, learnerId);
  const staff = asStaff(["billing_administrator"]);
  const resolved = resolveCustomer(staff, { identifierType: "subscription_ref", identifierValue: subscriptionId, reason: REASON });
  caseId = createSupportCase(staff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() }).caseId;
});

describe("AD-003 routes (AT-AD-003-01/03/14/23/81/82)", () => {
  it("AT-81: a routine workspace GET does not require fresh reauth", async () => {
    const response = await getWorkspace(
      new Request(`http://x/v1/admin/support/cases/${caseId}/billing?subscriptionId=${subscriptionId}`),
      { params: { caseId } },
    );
    expect(response.status).toBe(200);
  });

  it("AT-03: a support-only staff member is denied the billing workspace", async () => {
    asStaff(["support_agent"]);
    const response = await getWorkspace(
      new Request(`http://x/v1/admin/support/cases/${caseId}/billing?subscriptionId=${subscriptionId}`),
      { params: { caseId } },
    );
    expect(response.status).toBe(403);
  });

  it("AT-14/82: reassignment requires fresh <=10m reauth", async () => {
    const response = await postReassign(jsonRequest(`http://x/v1/admin/support/cases/${caseId}/billing/reassign-subscription`, "POST", {
      subscriptionId, targetLearnerId: randomUUID(), reasonCode: "test", effectiveMode: "immediate_if_unused",
      expectedSubscriptionVersion: 1, idempotencyKey: randomUUID(),
    }), { params: { caseId } });
    expect(response.status).toBe(401);
  });

  it("AT-23/82: refund requires fresh <=10m reauth", async () => {
    const response = await postRefund(jsonRequest(`http://x/v1/admin/support/cases/${caseId}/billing/refunds`, "POST", {
      subscriptionId, refundType: "full", reasonCode: "test", idempotencyKey: randomUUID(),
    }), { params: { caseId } });
    expect(response.status).toBe(401);
  });

  it("a full happy path reassignment succeeds once reauth is fresh", async () => {
    mocks.hasLiveReauthReceipt.mockReturnValue(true);
    const targetLearnerId = createLearner(parentId, { displayName: "Kid2", dateOfBirth: "2019-01-01", idempotencyKey: randomUUID() }, "2026-08-16").learner.id;
    const response = await postReassign(jsonRequest(`http://x/v1/admin/support/cases/${caseId}/billing/reassign-subscription`, "POST", {
      subscriptionId, targetLearnerId, reasonCode: "parent_request", effectiveMode: "immediate_if_unused",
      expectedSubscriptionVersion: 1, idempotencyKey: randomUUID(),
    }), { params: { caseId } });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe("executed");
  });
});
