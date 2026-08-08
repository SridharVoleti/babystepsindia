// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  checkRateLimit: vi.fn(),
  completeParentOnboarding: vi.fn(),
  getOnboardingProfile: vi.fn(),
  withLockedEndUserMutation: vi.fn((input: { mutate: () => unknown }) => input.mutate()),
}));

vi.mock("@/lib/authorization/api-guard", () => ({
  requireEndUserAuthorization: mocks.requireEndUserAuthorization,
}));
vi.mock("@/lib/auth/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));
vi.mock("@/lib/db/parent-profile-repo", () => ({
  completeParentOnboarding: mocks.completeParentOnboarding,
  getOnboardingProfile: mocks.getOnboardingProfile,
}));
vi.mock("@/lib/authorization/locked-mutation", () => ({
  withLockedEndUserMutation: mocks.withLockedEndUserMutation,
}));

import { GET, PATCH } from "@/app/v1/parent/profile/route";

describe("IA-002 parent profile API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockReturnValue(true);
    mocks.requireEndUserAuthorization.mockResolvedValue({
      ok: true,
      parent: {
        session: { sub: "parent-1" },
        user: { email: "authenticated@example.com" },
      },
      authorization: { mode: "parent_management" },
    });
    mocks.completeParentOnboarding.mockReturnValue({ id: "parent-1" });
    mocks.getOnboardingProfile.mockReturnValue({
      email: "authenticated@example.com",
      onboardingStatus: "learner_pending",
    });
  });

  it("AT-IA-002-07 ignores a forged request email and uses authenticated identity", async () => {
    const response = await PATCH(
      new Request("https://platform.example/v1/parent/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "attacker@example.com",
          displayName: "Asha",
          phoneCountryCode: "IN",
          mobileNumber: "9876543210",
          acceptedTermsVersion: "1.0",
          acceptedPrivacyVersion: "1.0",
        }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ email: "authenticated@example.com" });
    expect(mocks.completeParentOnboarding).toHaveBeenCalledWith(
      "parent-1",
      expect.not.objectContaining({ email: expect.anything() }),
    );
    expect(mocks.getOnboardingProfile).toHaveBeenCalledWith(
      "parent-1",
      "authenticated@example.com",
    );
  });

  it("AT-IA-002-13 returns authorization denial before reading phone-bearing profile data", async () => {
    const denied = Response.json({ error: "RESOURCE_NOT_FOUND" }, { status: 404 });
    mocks.requireEndUserAuthorization.mockResolvedValueOnce({ ok: false, response: denied });

    const response = await GET(new Request("https://platform.example/v1/parent/profile"));

    expect(response).toBe(denied);
    expect(mocks.getOnboardingProfile).not.toHaveBeenCalled();
  });

  it("AT-IA-002-10 rejects excluded parent address and date-of-birth fields", async () => {
    const response = await PATCH(
      new Request("https://platform.example/v1/parent/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: "Asha",
          phoneCountryCode: "IN",
          mobileNumber: "9876543210",
          acceptedTermsVersion: "1.0",
          acceptedPrivacyVersion: "1.0",
          postalAddress: "123 Unwanted Street",
          parentDateOfBirth: "1990-01-01",
        }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "UNEXPECTED_PROFILE_FIELD" });
    expect(mocks.completeParentOnboarding).not.toHaveBeenCalled();
  });
});
