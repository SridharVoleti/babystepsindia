// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireInternalService: vi.fn(), requireAdminApi: vi.fn(), verifyReauth: vi.fn(),
  hasRecentAdminAuthentication: vi.fn(), checkRateLimit: vi.fn(), readAppAvailability: vi.fn(),
  readAdminAvailability: vi.fn(), scheduleMaintenanceWindow: vi.fn(), updateMaintenanceWindow: vi.fn(),
  transitionAvailability: vi.fn(),
}));
vi.mock("@/lib/auth/internal-service-guard", () => ({ requireInternalService: mocks.requireInternalService }));
vi.mock("@/lib/auth/admin-api-guard", () => ({ requireAdminApi: mocks.requireAdminApi,
  verifyReauth: mocks.verifyReauth, hasRecentAdminAuthentication: mocks.hasRecentAdminAuthentication }));
vi.mock("@/lib/auth/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/app-availability/service", () => ({
  AppAvailabilityError: class AppAvailabilityError extends Error { constructor(public code: string) { super(code); } },
  appAvailabilityErrorStatus: () => 409, readAppAvailability: mocks.readAppAvailability,
  readAdminAvailability: mocks.readAdminAvailability, scheduleMaintenanceWindow: mocks.scheduleMaintenanceWindow,
  updateMaintenanceWindow: mocks.updateMaintenanceWindow, transitionAvailability: mocks.transitionAvailability,
}));

import { GET as internalGet } from "@/app/v1/internal/apps/[appId]/availability/route";
import { GET as adminGet } from "@/app/v1/admin/apps/[appId]/availability/route";
import { POST as schedulePost } from "@/app/v1/admin/apps/[appId]/maintenance-windows/route";
import { PATCH as windowPatch } from "@/app/v1/admin/apps/[appId]/maintenance-windows/[windowId]/route";
import { POST as transitionPost } from "@/app/v1/admin/apps/[appId]/availability-transition/route";

const adminGuard = { ok: true as const, session: { sub: "admin-1", email: "admin@example.com", iat: 1 } };
beforeEach(() => {
  vi.clearAllMocks(); mocks.requireInternalService.mockResolvedValue({ ok: true, principal: { id: "service-1" } });
  mocks.requireAdminApi.mockResolvedValue(adminGuard); mocks.verifyReauth.mockResolvedValue(true);
  mocks.hasRecentAdminAuthentication.mockReturnValue(true); mocks.checkRateLimit.mockReturnValue(true);
  mocks.readAppAvailability.mockReturnValue({ availabilityVersion: 1 });
  mocks.readAdminAvailability.mockReturnValue({ availabilityVersion: 1, windows: [] });
  mocks.scheduleMaintenanceWindow.mockReturnValue({ availabilityVersion: 2, windows: [] });
  mocks.updateMaintenanceWindow.mockReturnValue({ availabilityVersion: 3, windows: [] });
  mocks.transitionAvailability.mockReturnValue({ availabilityVersion: 2, operationalAvailability: "restoring" });
});

describe("UL-004 API-UL-011 through API-UL-014 routes", () => {
  it("uses the exact availability-reader service identity for internal reads", async () => {
    const response = await internalGet(new Request("https://example.test/v1/internal/apps/app-1/availability?environment=production"),
      { params: { appId: "app-1" } });
    expect(response.status).toBe(200);
    expect(mocks.requireInternalService).toHaveBeenCalledWith(expect.any(Request), "app-availability-reader");
    expect(mocks.readAppAvailability).toHaveBeenCalledWith("app-1", "production", expect.any(Date));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires exact read permission and recent authentication for the admin view", async () => {
    const response = await adminGet(new Request("https://example.test/v1/admin/apps/app-1/availability"),
      { params: { appId: "app-1" } });
    expect(response.status).toBe(200);
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("app_availability_read");
    expect(mocks.hasRecentAdminAuthentication).toHaveBeenCalledWith(adminGuard.session);
    mocks.hasRecentAdminAuthentication.mockReturnValue(false);
    expect((await adminGet(new Request("https://example.test/v1/admin/apps/app-1/availability"),
      { params: { appId: "app-1" } })).status).toBe(401);
  });

  it("requires manage permission, password reauth, versions, and idempotency for maintenance mutations", async () => {
    const response = await schedulePost(new Request("https://example.test/v1/admin/apps/app-1/maintenance-windows", {
      method: "POST", body: JSON.stringify({ environment: "production", startsAt: "2026-08-12T10:00:00Z",
        endsAt: "2026-08-12T11:00:00Z", reasonCategory: "planned", expectedAvailabilityVersion: 1,
        idempotencyKey: "key-1", currentPassword: "password" }) }), { params: { appId: "app-1" } });
    expect(response.status).toBe(201);
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("app_availability_manage");
    expect(mocks.verifyReauth).toHaveBeenCalledWith("admin@example.com", "password");
    expect(mocks.scheduleMaintenanceWindow).toHaveBeenCalledWith(expect.objectContaining({ appId: "app-1",
      expectedAvailabilityVersion: 1, idempotencyKey: "key-1", actorId: "admin-1" }), expect.any(Date));

    await windowPatch(new Request("https://example.test/v1/admin/apps/app-1/maintenance-windows/window-1", {
      method: "PATCH", body: JSON.stringify({ action: "cancel", expectedAvailabilityVersion: 2,
        expectedWindowVersion: 1, idempotencyKey: "key-2", currentPassword: "password" }) }),
      { params: { appId: "app-1", windowId: "window-1" } });
    expect(mocks.updateMaintenanceWindow).toHaveBeenCalledWith(expect.objectContaining({ action: "cancel",
      expectedAvailabilityVersion: 2, expectedWindowVersion: 1 }), expect.any(Date));
  });

  it("never exposes security_blocked as an ordinary transition target", async () => {
    const denied = await transitionPost(new Request("https://example.test/v1/admin/apps/app-1/availability-transition", {
      method: "POST", body: JSON.stringify({ targetState: "security_blocked", currentPassword: "password" }) }),
      { params: { appId: "app-1" } });
    expect(denied.status).toBe(422);
    expect(mocks.transitionAvailability).not.toHaveBeenCalled();
  });
});
