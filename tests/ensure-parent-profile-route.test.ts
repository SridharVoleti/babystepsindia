import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUserById: vi.fn(),
  ensureParentProfile: vi.fn(),
  requireEndUserAuthorization: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/auth/sqlite-auth-adapter", () => ({
  sqliteAuthAdapter: { getUserById: mocks.getUserById },
}));
vi.mock("@/lib/auth/parent-profile", () => ({ ensureParentProfile: mocks.ensureParentProfile }));
vi.mock("@/lib/db/parent-profile-store", () => ({ sqliteParentProfileStore: {} }));
vi.mock("@/lib/authorization/api-guard", () => ({
  requireEndUserAuthorization: mocks.requireEndUserAuthorization,
}));

import { POST } from "@/app/v1/onboarding/ensure-parent-profile/route";

const profile = {
  id: "parent-1",
  account_status: "active",
  onboarding_status: "profile_pending",
  auth_revoked_before: null,
};

describe("IA-001 parent-profile recovery boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      sub: "parent-1",
      sid: "session-1",
      did: "device-1",
    });
    mocks.getUserById.mockResolvedValue({ id: "parent-1", emailVerified: true });
    mocks.ensureParentProfile.mockResolvedValue({ profile, created: false });
  });

  it("AT-IA-001-04 denies recovery-profile data while the browser is in learner mode", async () => {
    mocks.requireEndUserAuthorization.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "PARENT_REAUTHENTICATION_REQUIRED" }, { status: 403 }),
    });

    const response = await POST(new Request(
      "http://localhost/v1/onboarding/ensure-parent-profile",
      { method: "POST" },
    ));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "PARENT_REAUTHENTICATION_REQUIRED" });
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(
      expect.any(Request),
      "parent.onboarding.ensure",
      { parentUserId: "parent-1" },
    );
  });
});
