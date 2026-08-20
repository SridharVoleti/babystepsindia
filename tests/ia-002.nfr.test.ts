// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import {
  completeParentOnboarding,
  getOnboardingProfile,
} from "@/lib/db/parent-profile-repo";

beforeEach(() => useInMemoryDb());

describe("IA-002 non-functional requirements", () => {
  it("keeps local profile load/update p95 below 1.5 seconds", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent@example.com", "CorrectHorse1!");
    const value = {
      displayName: "Asha",
      phoneE164: "+919876543210",
      phoneCountryCode: "IN",
      locale: "en-IN",
      timezone: "Asia/Kolkata",
    };
    await completeParentOnboarding(user.id, value);

    const durations: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      expect(await getOnboardingProfile(user.id, user.email)).not.toBeNull();
      await completeParentOnboarding(user.id, value);
      durations.push(performance.now() - started);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1];

    expect(p95).toBeLessThan(1_500);
  });
});
