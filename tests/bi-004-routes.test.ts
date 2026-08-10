import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveApiRouteAuthorization } from "@/lib/authorization/route-actions";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  withLockedEndUserMutation: vi.fn((input: any) => input.mutate()),
  cancelSubscriptionAtPeriodEnd: vi.fn(),
  resumeSubscriptionAutoRenewal: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({
  requireEndUserAuthorization: mocks.requireEndUserAuthorization,
}));
vi.mock("@/lib/authorization/locked-mutation", () => ({
  withLockedEndUserMutation: mocks.withLockedEndUserMutation,
}));
vi.mock("@/lib/auth/rate-limit", () => ({ checkRateLimit: () => true }));
vi.mock("@/lib/billing/bi004-service", () => ({
  cancelSubscriptionAtPeriodEnd: mocks.cancelSubscriptionAtPeriodEnd,
  resumeSubscriptionAutoRenewal: mocks.resumeSubscriptionAutoRenewal,
}));

import { POST as cancelSubscription } from "@/app/v1/parent/subscriptions/[subscriptionId]/cancel/route";
import { POST as resumeAutoRenew } from "@/app/v1/parent/subscriptions/[subscriptionId]/resume-auto-renew/route";

const guard = { ok: true, parent: { session: { sub: "parent-1" } }, authorization: {} };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue(guard);
  mocks.cancelSubscriptionAtPeriodEnd.mockReturnValue({ cancelAtPeriodEnd: true, version: 3 });
  mocks.resumeSubscriptionAutoRenewal.mockReturnValue({ providerHostedSetupRequired: false, version: 4 });
});

describe("BI-004 route contracts", () => {
  it("API-BI-008 derives the purchasing parent and uses the locked cancellation mutation", async () => {
    const response = await cancelSubscription(new Request(
      "https://example.test/v1/parent/subscriptions/sub-1/cancel", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: 2, idempotencyKey: "cancel-1", parentId: "forged" }),
      }), { params: { subscriptionId: "sub-1" } });
    expect(response.status).toBe(200);
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.any(Request),
      "parent.billing.subscription.cancel");
    expect(mocks.cancelSubscriptionAtPeriodEnd).toHaveBeenCalledWith("parent-1", "sub-1",
      { expectedVersion: 2, idempotencyKey: "cancel-1" });
  });

  it("API-BI-015 returns 202 while provider-hosted recurring setup remains unconfirmed", async () => {
    mocks.resumeSubscriptionAutoRenewal.mockReturnValue({ providerHostedSetupRequired: true,
      setupUrl: "/provider/setup", version: 4 });
    const response = await resumeAutoRenew(new Request(
      "https://example.test/v1/parent/subscriptions/sub-1/resume-auto-renew", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: 3, idempotencyKey: "resume-1" }),
      }), { params: { subscriptionId: "sub-1" } });
    expect(response.status).toBe(202);
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.any(Request),
      "parent.billing.auto_renew.resume");
    expect(mocks.resumeSubscriptionAutoRenewal).toHaveBeenCalledWith("parent-1", "sub-1",
      { expectedVersion: 3, idempotencyKey: "resume-1" });
  });

  it("AT-BI-004-02/33 rejects missing version/idempotency before mutation", async () => {
    const response = await cancelSubscription(new Request(
      "https://example.test/v1/parent/subscriptions/sub-1/cancel", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ immediate: true }),
      }), { params: { subscriptionId: "sub-1" } });
    expect(response.status).toBe(400);
    expect(mocks.cancelSubscriptionAtPeriodEnd).not.toHaveBeenCalled();
  });

  it("AT-BI-004-04/34 exposes only cancel/resume actions—no pause or immediate termination route", () => {
    expect(resolveApiRouteAuthorization("POST", "/v1/parent/subscriptions/sub-1/cancel"))
      .toBe("parent.billing.subscription.cancel");
    expect(resolveApiRouteAuthorization("POST", "/v1/parent/subscriptions/sub-1/resume-auto-renew"))
      .toBe("parent.billing.auto_renew.resume");
    expect(resolveApiRouteAuthorization("POST", "/v1/parent/subscriptions/sub-1/pause")).toBeUndefined();
    expect(resolveApiRouteAuthorization("POST", "/v1/parent/subscriptions/sub-1/terminate-now")).toBeUndefined();
  });
});
