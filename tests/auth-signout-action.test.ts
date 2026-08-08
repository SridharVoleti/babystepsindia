// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  clearSessionCookie: vi.fn(),
  revokeLearnerContextsForSession: vi.fn(),
  redirect: vi.fn((location: string) => {
    throw new Error(`REDIRECT:${location}`);
  }),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/auth/session", () => ({
  getSession: mocks.getSession,
  clearSessionCookie: mocks.clearSessionCookie,
  setSessionCookie: vi.fn(),
}));
vi.mock("@/lib/authorization/modes", () => ({
  revokeLearnerContextsForSession: mocks.revokeLearnerContextsForSession,
}));

import { signOutAction } from "@/app/(auth)/actions";

describe("IA-001 sign out", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({ sid: "session-1", sub: "parent-1" });
  });

  it("AT-IA-001-05 revokes nested authority before clearing the authenticated session", async () => {
    await expect(signOutAction()).rejects.toThrow("REDIRECT:/");

    expect(mocks.revokeLearnerContextsForSession).toHaveBeenCalledWith(
      "session-1",
      expect.any(Date),
    );
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();
    expect(mocks.revokeLearnerContextsForSession.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.clearSessionCookie.mock.invocationCallOrder[0]);
  });
});
