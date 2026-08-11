// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimitsForTests } from "@/lib/auth/rate-limit";

const mocks = vi.hoisted(() => ({
  requireAdminApi: vi.fn(),
  verifyReauth: vi.fn(),
  applyLifecycleEvent: vi.fn(),
  dbGet: vi.fn(),
}));

vi.mock("@/lib/auth/admin-api-guard", () => ({
  requireAdminApi: mocks.requireAdminApi,
  verifyReauth: mocks.verifyReauth,
}));
vi.mock("@/lib/entitlement-lifecycle/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/entitlement-lifecycle/service")>();
  return { ...actual, applyLifecycleEvent: mocks.applyLifecycleEvent };
});
vi.mock("@/lib/db/client", () => ({
  getDb: () => ({ prepare: () => ({ get: mocks.dbGet }) }),
}));

import { POST as revokeRoute } from "@/app/v1/admin/entitlements/[effectiveEntitlementId]/revoke/route";

const adminGuard = { ok: true as const,
  session: { sub: "admin-1", email: "admin@example.com", iat: Math.floor(Date.now() / 1000) } };

function request(body: unknown) {
  return new Request("https://platform.example/v1/admin/entitlements/entitlement-1/revoke", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimitsForTests();
  mocks.requireAdminApi.mockResolvedValue(adminGuard);
  mocks.verifyReauth.mockResolvedValue(true);
  mocks.dbGet.mockReturnValue({ learner_id: "learner-1", app_id: "app-1", lifecycle_version: 3 });
  mocks.applyLifecycleEvent.mockReturnValue({ eventId: "event-1", status: "applied", affected: [] });
});

describe("EN-003 admin security-revoke route", () => {
  it("is gated behind the entitlement_security_revoke permission", async () => {
    mocks.requireAdminApi.mockResolvedValueOnce({ ok: false,
      response: Response.json({ error: "FORBIDDEN" }, { status: 403 }) });
    const response = await revokeRoute(request({}), { params: { effectiveEntitlementId: "entitlement-1" } });
    expect(response.status).toBe(403);
  });

  it("requires reauthentication before revoking", async () => {
    mocks.verifyReauth.mockResolvedValueOnce(false);
    const response = await revokeRoute(request({ currentPassword: "wrong", reasonCategory: "security_admin_action",
      eventId: "event-1" }), { params: { effectiveEntitlementId: "entitlement-1" } });
    expect(response.status).toBe(401);
    expect(mocks.applyLifecycleEvent).not.toHaveBeenCalled();
  });

  it("returns RESOURCE_NOT_FOUND for an unknown effective entitlement", async () => {
    mocks.dbGet.mockReturnValueOnce(undefined);
    const response = await revokeRoute(request({ currentPassword: "correct", reasonCategory: "security_admin_action",
      eventId: "event-1" }), { params: { effectiveEntitlementId: "missing" } });
    expect(response.status).toBe(404);
  });

  it("routes through applyLifecycleEvent, never a direct entitlement-state write", async () => {
    const response = await revokeRoute(request({ currentPassword: "correct", reasonCategory: "security_admin_action",
      eventId: "event-1", fraudOrSecurityRisk: true }), { params: { effectiveEntitlementId: "entitlement-1" } });
    expect(response.status).toBe(200);
    expect(mocks.applyLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "security_revoked", source: "platform_security",
      sourceReference: expect.objectContaining({ learnerId: "learner-1", appId: "app-1",
        reasonCategory: "security_admin_action", fraudOrSecurityRisk: true }),
    }));
  });
});
