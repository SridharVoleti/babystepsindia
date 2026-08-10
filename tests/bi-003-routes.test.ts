import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(), requireInternalService: vi.fn(),
  getPaymentRecoveryStatus: vi.fn(), createPaymentMethodUpdateSession: vi.fn(), runGraceExpirySweep: vi.fn(),
}));
vi.mock("@/lib/authorization/api-guard", () => ({
  requireEndUserAuthorization: mocks.requireEndUserAuthorization,
}));
vi.mock("@/lib/auth/internal-service-guard", () => ({ requireInternalService: mocks.requireInternalService }));
vi.mock("@/lib/billing/bi003-service", () => ({ getPaymentRecoveryStatus: mocks.getPaymentRecoveryStatus,
  createPaymentMethodUpdateSession: mocks.createPaymentMethodUpdateSession,
  runGraceExpirySweep: mocks.runGraceExpirySweep }));

import { GET as recoveryStatus } from "@/app/v1/parent/subscriptions/[subscriptionId]/payment-recovery-status/route";
import { POST as paymentUpdate } from "@/app/v1/parent/subscriptions/[subscriptionId]/payment-method-update-session/route";
import { POST as graceSweep } from "@/app/v1/internal/billing/grace-expiry-sweep/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue({ ok: true, parent: { session: { sub: "parent-1" } } });
  mocks.requireInternalService.mockResolvedValue({ ok: true, principal: { id: "recovery-service-1" } });
  mocks.getPaymentRecoveryStatus.mockReturnValue({ paymentState: "past_due_grace" });
  mocks.createPaymentMethodUpdateSession.mockReturnValue({ updateUrl: "/provider/update", expiresAt: "soon" });
  mocks.runGraceExpirySweep.mockReturnValue({ scanned: 1, expired: 1 });
});

describe("BI-003 route contracts", () => {
  it("API-BI-012 scopes recovery status to the verified purchasing parent", async () => {
    const response = await recoveryStatus(new Request("https://example.test/v1/parent/subscriptions/sub-1/payment-recovery-status"),
      { params: { subscriptionId: "sub-1" } });
    expect(response.status).toBe(200);
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.any(Request),
      "parent.billing.payment_recovery.read");
    expect(mocks.getPaymentRecoveryStatus).toHaveBeenCalledWith("parent-1", "sub-1");
  });

  it("API-BI-011 derives the parent and accepts only version plus idempotency key", async () => {
    const response = await paymentUpdate(new Request(
      "https://example.test/v1/parent/subscriptions/sub-1/payment-method-update-session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: 4, idempotencyKey: "update-1", parentId: "forged" }),
      }), { params: { subscriptionId: "sub-1" } });
    expect(response.status).toBe(201);
    expect(mocks.createPaymentMethodUpdateSession).toHaveBeenCalledWith("parent-1", "sub-1",
      { expectedVersion: 4, idempotencyKey: "update-1" });
  });

  it("API-BI-013 requires the distinct billing-recovery principal and bounded input", async () => {
    const response = await graceSweep(new Request("https://example.test/v1/internal/billing/grace-expiry-sweep", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "local-provider", cursor: "sub-0", limit: 100,
        runIdempotencyKey: "grace-run-1" }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.requireInternalService).toHaveBeenCalledWith(expect.any(Request), "billing-recovery");
    expect(mocks.runGraceExpirySweep).toHaveBeenCalledWith("recovery-service-1",
      { provider: "local-provider", cursor: "sub-0", limit: 100, runIdempotencyKey: "grace-run-1" });
  });

  it("rejects browser-shaped attempts to mark payment recovered or extend grace", async () => {
    const response = await paymentUpdate(new Request(
      "https://example.test/v1/parent/subscriptions/sub-1/payment-method-update-session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markRecovered: true, graceEndsAt: "2099-01-01T00:00:00.000Z" }),
      }), { params: { subscriptionId: "sub-1" } });
    expect(response.status).toBe(400);
    expect(mocks.createPaymentMethodUpdateSession).not.toHaveBeenCalled();
  });
});
