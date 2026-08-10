import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  requireInternalService: vi.fn(),
  withLockedEndUserMutation: vi.fn((input: any) => input.mutate()),
  processSignedProviderWebhook: vi.fn(),
  getSubscriptionBillingStatus: vi.fn(),
  disableSubscriptionAutoRenewal: vi.fn(),
  reconcileBilling: vi.fn(),
  runUpcomingRenewalReminderSweep: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({
  requireEndUserAuthorization: mocks.requireEndUserAuthorization,
}));
vi.mock("@/lib/auth/internal-service-guard", () => ({ requireInternalService: mocks.requireInternalService }));
vi.mock("@/lib/authorization/locked-mutation", () => ({
  withLockedEndUserMutation: mocks.withLockedEndUserMutation,
}));
vi.mock("@/lib/auth/rate-limit", () => ({ checkRateLimit: () => true }));
vi.mock("@/lib/billing/bi002-service", () => ({
  processSignedProviderWebhook: mocks.processSignedProviderWebhook,
  getSubscriptionBillingStatus: mocks.getSubscriptionBillingStatus,
  disableSubscriptionAutoRenewal: mocks.disableSubscriptionAutoRenewal,
  reconcileBilling: mocks.reconcileBilling,
  runUpcomingRenewalReminderSweep: mocks.runUpcomingRenewalReminderSweep,
}));

import { POST as paymentWebhook } from "@/app/v1/webhooks/payments/[provider]/route";
import { GET as billingStatus } from "@/app/v1/parent/subscriptions/[subscriptionId]/billing-status/route";
import { POST as disableRenewal } from "@/app/v1/parent/subscriptions/[subscriptionId]/disable-auto-renew/route";
import { POST as reconcile } from "@/app/v1/internal/billing/reconcile/route";
import { POST as reminderSweep } from "@/app/v1/internal/billing/upcoming-renewal-reminder-sweep/route";

const parentGuard = { ok: true, parent: { session: { sub: "parent-1" } }, authorization: {} };
const serviceGuard = { ok: true, principal: { id: "service-1" } };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue(parentGuard);
  mocks.requireInternalService.mockResolvedValue(serviceGuard);
  mocks.processSignedProviderWebhook.mockReturnValue({ resultCode: "SUBSCRIPTION_ACTIVATED" });
  mocks.getSubscriptionBillingStatus.mockReturnValue({ subscriptionId: "sub-1" });
  mocks.disableSubscriptionAutoRenewal.mockReturnValue({ autoRenewEnabled: false });
  mocks.reconcileBilling.mockReturnValue({ processed: 0 });
  mocks.runUpcomingRenewalReminderSweep.mockReturnValue({ sent: 0 });
});

describe("BI-002 route contracts", () => {
  it("AT-BI-002-17/43 passes the untouched raw body and signature namespace without parent auth", async () => {
    const rawBody = "{\"providerEventId\":\"event-1\",\"amount\":29900}";
    const response = await paymentWebhook(new Request("https://platform.example/v1/webhooks/payments/local-provider", {
      method: "POST", body: rawBody, headers: { "x-billing-signature": "signature",
        "x-billing-environment": "test", "x-billing-account-id": "account-1" },
    }), { params: { provider: "local-provider" } });
    expect(response.status).toBe(200);
    expect(mocks.processSignedProviderWebhook).toHaveBeenCalledWith("local-provider", {
      rawBody, signature: "signature", environment: "test", accountId: "account-1",
    });
    expect(mocks.requireEndUserAuthorization).not.toHaveBeenCalled();
  });

  it("API-BI-009 scopes billing status to the authenticated purchasing parent", async () => {
    const response = await billingStatus(new Request("https://platform.example/v1/parent/subscriptions/sub-1/billing-status"),
      { params: { subscriptionId: "sub-1" } });
    expect(response.status).toBe(200);
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.any(Request), "parent.billing.status.read");
    expect(mocks.getSubscriptionBillingStatus).toHaveBeenCalledWith("parent-1", "sub-1");
  });

  it("AT-BI-002-28 disablement derives the parent and uses locked versioned mutation", async () => {
    const response = await disableRenewal(new Request(
      "https://platform.example/v1/parent/subscriptions/sub-1/disable-auto-renew", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: 2, idempotencyKey: "key-1", parentId: "forged" }),
      }), { params: { subscriptionId: "sub-1" } });
    expect(response.status).toBe(200);
    expect(mocks.disableSubscriptionAutoRenewal).toHaveBeenCalledWith("parent-1", "sub-1",
      { expectedVersion: 2, idempotencyKey: "key-1" });
  });

  it("API-BI-010 requires the exact reconciliation machine identity", async () => {
    const response = await reconcile(new Request("https://platform.example/v1/internal/billing/reconcile", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        provider: "local-provider", environment: "test", startDate: "2026-08-10T00:00:00.000Z",
        endDate: "2026-08-11T00:00:00.000Z", limit: 100, runIdempotencyKey: "run-1",
      }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.requireInternalService).toHaveBeenCalledWith(expect.any(Request), "billing-reconciliation");
    expect(mocks.reconcileBilling).toHaveBeenCalledWith("service-1", expect.objectContaining({
      runIdempotencyKey: "run-1",
    }));
  });

  it("API-BI-014 requires the distinct billing-notification principal", async () => {
    const response = await reminderSweep(new Request(
      "https://platform.example/v1/internal/billing/upcoming-renewal-reminder-sweep", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          startDueAt: "2026-09-03T10:00:00.000Z", endDueAt: "2026-09-03T10:01:00.000Z",
          limit: 100, runIdempotencyKey: "run-2",
        }),
      }));
    expect(response.status).toBe(200);
    expect(mocks.requireInternalService).toHaveBeenCalledWith(expect.any(Request), "billing-notification");
  });
});
