// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { cadenceCelebrationPresentationKey, markCadenceCelebrationPresented,
  shouldPresentCadenceCelebration } from "@/lib/cadence-celebration/app-sdk";
import type { CadenceCelebrationContext } from "@/lib/cadence-celebration/contracts";

const context: CadenceCelebrationContext = { eligible: true, weeklyKey: "2026-W33", cadenceTarget: 2,
  completedSessions: 2, currentStreakWeeks: 3, longestStreakWeeks: 5,
  appRef: { appId: "math", appKey: "magical-math", displayName: "Magical Math" },
  celebrationContextVersion: "1.0" };

beforeEach(() => localStorage.clear());

describe("EG-003 app integration SDK", () => {
  it("supports only app-local, non-authoritative retry suppression", () => {
    expect(shouldPresentCadenceCelebration(localStorage, "session-2", context)).toBe(true);
    markCadenceCelebrationPresented(localStorage, "session-2", context);
    expect(shouldPresentCadenceCelebration(localStorage, "session-2", context)).toBe(false);
    expect(shouldPresentCadenceCelebration(localStorage, "session-other", context)).toBe(true);
    expect(cadenceCelebrationPresentationKey("session-2", context)).not.toMatch(/learner|parent|progress|answer/i);
  });

  it("exports no Babysteps art, copy, audio, reward, CTA, or rendering component", async () => {
    const sdk = await import("@/lib/cadence-celebration/app-sdk");
    expect(Object.keys(sdk).sort()).toEqual(["cadenceCelebrationPresentationKey",
      "markCadenceCelebrationPresented", "shouldPresentCadenceCelebration"]);
    expect(JSON.stringify(sdk)).not.toMatch(/component|animation|audio|reward|credit|xp|extra.session|launch/i);
  });
});
