// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimitsForTests } from "@/lib/auth/rate-limit";
import { resolveApiRouteAuthorization } from "@/lib/authorization/route-actions";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  withLockedEndUserMutation: vi.fn((input: { mutate: () => unknown }) => input.mutate()),
  createCheckoutIntent: vi.fn(),
  createReassignmentCase: vi.fn(),
  listParentSubscriptions: vi.fn(),
  requireAdminApi: vi.fn(),
  hasRecentAdminAuthentication: vi.fn(),
  requireReauth: vi.fn(),
  getAdminReassignmentCase: vi.fn(),
  executeSubscriptionReassignment: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({
  requireEndUserAuthorization: mocks.requireEndUserAuthorization,
}));
vi.mock("@/lib/authorization/locked-mutation", () => ({
  withLockedEndUserMutation: mocks.withLockedEndUserMutation,
}));
vi.mock("@/lib/auth/admin-api-guard", () => ({
  requireAdminApi: mocks.requireAdminApi,
  hasRecentAdminAuthentication: mocks.hasRecentAdminAuthentication,
  requireReauth: mocks.requireReauth,
}));
vi.mock("@/lib/billing/bi001-service", () => ({
  createCheckoutIntent: mocks.createCheckoutIntent,
  createReassignmentCase: mocks.createReassignmentCase,
  listParentSubscriptions: mocks.listParentSubscriptions,
  getAdminReassignmentCase: mocks.getAdminReassignmentCase,
  executeSubscriptionReassignment: mocks.executeSubscriptionReassignment,
}));

import { POST as createCheckout } from "@/app/v1/billing/checkout-intents/route";
import { POST as createCase } from "@/app/v1/subscription-reassignment-cases/route";
import { GET as readAdminCase } from "@/app/v1/admin/subscription-reassignment-cases/[caseId]/route";
import { POST as executeAdminReassignment } from "@/app/v1/admin/subscriptions/[subscriptionId]/reassign-learner/route";

const parentGuard = {
  ok: true as const,
  parent: { session: { sub: "parent-1" } },
  authorization: { parentUserId: "parent-1", parentSessionId: "session-1", deviceSessionId: "device-1",
    mode: "parent_management" },
};
const adminGuard = { ok: true as const,
  session: { sub: "admin-1", email: "admin@example.com", iat: Math.floor(Date.now() / 1000) } };

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimitsForTests();
  mocks.requireEndUserAuthorization.mockResolvedValue(parentGuard);
  mocks.requireAdminApi.mockResolvedValue(adminGuard);
  mocks.hasRecentAdminAuthentication.mockReturnValue(true);
  mocks.requireReauth.mockReturnValue(null);
  mocks.createCheckoutIntent.mockReturnValue({ checkoutIntentId: "checkout-1" });
  mocks.createReassignmentCase.mockReturnValue({ caseId: "case-1", status: "open" });
  mocks.getAdminReassignmentCase.mockReturnValue({ caseId: "case-1" });
  mocks.executeSubscriptionReassignment.mockReturnValue({ status: "executed" });
});

describe("BI-001 API authorization and contracts", () => {
  it("AT-BI-001-01/03 checkout derives purchaser from the authorized parent and scopes learner", async () => {
    const response = await createCheckout(new Request("https://platform.example/v1/billing/checkout-intents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ learnerId: "learner-1", productId: "product-1", productVersion: 1,
        priceId: "price-1", priceVersion: 1, autoRenewEnabled: true,
        consentDisclosureVersion: "recurring-billing-v1",
        idempotencyKey: "key-1", purchaserParentId: "forged-parent" }),
    }));
    expect(response.status).toBe(201);
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.any(Request),
      "parent.billing.checkout.create", { learnerId: "learner-1" });
    expect(mocks.createCheckoutIntent).toHaveBeenCalledWith("parent-1", {
      learnerId: "learner-1", productId: "product-1", productVersion: 1, idempotencyKey: "key-1",
      priceId: "price-1", priceVersion: 1, autoRenewEnabled: true,
      consentDisclosureVersion: "recurring-billing-v1",
    });
  });

  it("AT-BI-001-13 parent case creation changes no subscription directly", async () => {
    const response = await createCase(new Request("https://platform.example/v1/subscription-reassignment-cases", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscriptionId: "sub-1", targetLearnerId: "learner-2",
        reasonCode: "WRONG_LEARNER_SELECTED", idempotencyKey: "case-key" }),
    }));
    expect(response.status).toBe(201);
    expect(mocks.createReassignmentCase).toHaveBeenCalledWith("parent-1", expect.objectContaining({
      subscriptionId: "sub-1", targetLearnerId: "learner-2",
    }));
    expect(mocks.executeSubscriptionReassignment).not.toHaveBeenCalled();
  });

  it("AT-BI-001-14 admin read and execute require the exact billing permission", async () => {
    await readAdminCase(new Request("https://platform.example/v1/admin/subscription-reassignment-cases/case-1"),
      { params: { caseId: "case-1" } });
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.billing.reassignment_case.read");

    mocks.requireAdminApi.mockResolvedValueOnce({ ok: false,
      response: Response.json({ error: "FORBIDDEN" }, { status: 403 }) });
    const denied = await executeAdminReassignment(new Request("https://platform.example/v1/admin/subscriptions/sub-1/reassign-learner", {
      method: "POST", body: "{}" }), { params: { subscriptionId: "sub-1" } });
    expect(denied.status).toBe(403);
    expect(mocks.executeSubscriptionReassignment).not.toHaveBeenCalled();
  });

  it("AT-BI-001-15 recent reauthentication is enforced on read and execution", async () => {
    mocks.hasRecentAdminAuthentication.mockReturnValueOnce(false);
    const staleRead = await readAdminCase(
      new Request("https://platform.example/v1/admin/subscription-reassignment-cases/case-1"),
      { params: { caseId: "case-1" } });
    expect(staleRead.status).toBe(401);

    mocks.requireReauth.mockReturnValueOnce(Response.json({ error: "REAUTHENTICATION_REQUIRED" }, { status: 401 }));
    const staleMutation = await executeAdminReassignment(new Request(
      "https://platform.example/v1/admin/subscriptions/sub-1/reassign-learner", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: "wrong", caseId: "case-1", targetLearnerId: "learner-2",
          effectiveMode: "immediate_if_unused", reasonCode: "WRONG_LEARNER_SELECTED",
          expectedSubscriptionVersion: 1, expectedCaseVersion: 1, idempotencyKey: "admin-key" }),
      }), { params: { subscriptionId: "sub-1" } });
    expect(staleMutation.status).toBe(401);
    expect(mocks.executeSubscriptionReassignment).not.toHaveBeenCalled();
  });

  it("AT-BI-001-10/11 exposes no parent PATCH assigned-learner route", () => {
    expect(resolveApiRouteAuthorization("PATCH", "/v1/parent/subscriptions")).toBeUndefined();
    expect(resolveApiRouteAuthorization("PATCH", "/v1/parent/subscriptions/sub-1")).toBeUndefined();
  });
});
