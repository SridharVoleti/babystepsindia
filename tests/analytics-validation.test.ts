import { describe, expect, it } from "vitest";
import { AnalyticsError } from "@/lib/analytics/errors";
import { validateContributionPayload } from "@/lib/analytics/validation";

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    activityDate: "2026-08-04",
    learnerId: "learner-1",
    appId: "app-1",
    levelKey: "level-1",
    ageBand: "8_9",
    contributionId: "contribution-1",
    deltas: { engagedSeconds: 60, sessionsStarted: 1 },
    ...overrides,
  };
}

describe("validateContributionPayload", () => {
  it("accepts a well-formed payload and fills unset deltas with 0", () => {
    const result = validateContributionPayload(basePayload());
    expect(result).toEqual({
      activityDate: "2026-08-04",
      learnerId: "learner-1",
      appId: "app-1",
      levelKey: "level-1",
      ageBand: "8_9",
      contributionId: "contribution-1",
      deltas: {
        engagedSeconds: 60,
        sessionsStarted: 1,
        sessionsCompleted: 0,
        sessionsInterrupted: 0,
        lessonsCompleted: 0,
      },
    });
  });

  it("rejects an unapproved age band", () => {
    expect(() => validateContributionPayload(basePayload({ ageBand: "0_5" })))
      .toThrow(AnalyticsError);
  });

  // AT-AN-001-28: unknown/protected fields rejected — e.g. a caller
  // trying to smuggle raw DOB, exact age, or parent id through.
  it("rejects an unknown top-level field", () => {
    expect(() => validateContributionPayload(basePayload({ dateOfBirth: "2018-01-01" })))
      .toThrow(AnalyticsError);
  });

  it("rejects an unknown/protected field even when it looks harmless", () => {
    expect(() => validateContributionPayload(basePayload({ exactAgeYears: 8 })))
      .toThrow(AnalyticsError);
  });

  it("rejects an unknown field inside deltas", () => {
    expect(() => validateContributionPayload(basePayload({
      deltas: { engagedSeconds: 60, clientReportedTotalSeconds: 99999 },
    }))).toThrow(AnalyticsError);
  });

  it("rejects a negative delta", () => {
    expect(() => validateContributionPayload(basePayload({
      deltas: { engagedSeconds: -1 },
    }))).toThrow(AnalyticsError);
  });

  it("rejects a non-integer delta", () => {
    expect(() => validateContributionPayload(basePayload({
      deltas: { engagedSeconds: 1.5 },
    }))).toThrow(AnalyticsError);
  });

  it("rejects a missing required field", () => {
    const payload = basePayload();
    delete (payload as Record<string, unknown>).contributionId;
    expect(() => validateContributionPayload(payload)).toThrow(AnalyticsError);
  });

  it("rejects a malformed activityDate", () => {
    expect(() => validateContributionPayload(basePayload({ activityDate: "08/04/2026" })))
      .toThrow(AnalyticsError);
  });

  it("rejects a non-object payload", () => {
    expect(() => validateContributionPayload(null)).toThrow(AnalyticsError);
    expect(() => validateContributionPayload("nope")).toThrow(AnalyticsError);
    expect(() => validateContributionPayload([])).toThrow(AnalyticsError);
  });
});
