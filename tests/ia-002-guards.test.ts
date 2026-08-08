// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadParentContext: vi.fn(),
  redirect: vi.fn((destination: string) => {
    throw new Error(`REDIRECT:${destination}`);
  }),
}));

vi.mock("@/lib/auth/parent-context", () => ({
  loadParentContext: mocks.loadParentContext,
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));

import { requireVerifiedParent } from "@/lib/auth/guards";

const context = {
  authenticated: true,
  session: { sub: "parent-1", email: "parent@example.com", sid: "session-1", did: "device-1" },
  user: { id: "parent-1", email: "parent@example.com", emailVerified: true, isAdmin: false },
  profile: {
    id: "parent-1",
    account_status: "active",
    onboarding_status: "profile_pending",
    auth_revoked_before: null,
  },
  decision: { allowed: true, code: null },
};

describe("IA-002 onboarding guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("AT-IA-002-01 redirects a verified active profile_pending parent to onboarding", async () => {
    mocks.loadParentContext.mockResolvedValue(context);

    await expect(requireVerifiedParent()).rejects.toThrow("REDIRECT:/onboarding");
    expect(mocks.redirect).toHaveBeenCalledWith("/onboarding");
  });

  it("allows the parent through after profile onboarding advances", async () => {
    const advanced = {
      ...context,
      profile: { ...context.profile, onboarding_status: "learner_pending" },
    };
    mocks.loadParentContext.mockResolvedValue(advanced);

    await expect(requireVerifiedParent()).resolves.toEqual({
      session: advanced.session,
      profile: advanced.profile,
    });
  });
});
