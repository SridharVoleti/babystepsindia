import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalyticsError } from "@/lib/analytics/errors";
import { learnerDailyKey } from "@/lib/analytics/daily-key";

const ORIGINAL_SECRET = process.env.ANALYTICS_HMAC_SECRET;

beforeEach(() => {
  process.env.ANALYTICS_HMAC_SECRET = "test-only-analytics-secret-32-bytes-min";
});

afterEach(() => {
  process.env.ANALYTICS_HMAC_SECRET = ORIGINAL_SECRET;
});

// AT-AN-001-04: daily HMAC key, date-specific, no learner UUID stored.
describe("learnerDailyKey", () => {
  it("is deterministic for the same learner+date", () => {
    const a = learnerDailyKey("learner-1", "2026-08-04");
    const b = learnerDailyKey("learner-1", "2026-08-04");
    expect(a).toBe(b);
  });

  it("changes when the activity date changes (business rule 6)", () => {
    const day1 = learnerDailyKey("learner-1", "2026-08-04");
    const day2 = learnerDailyKey("learner-1", "2026-08-05");
    expect(day1).not.toBe(day2);
  });

  it("changes when the learner changes", () => {
    const a = learnerDailyKey("learner-1", "2026-08-04");
    const b = learnerDailyKey("learner-2", "2026-08-04");
    expect(a).not.toBe(b);
  });

  it("never contains the raw learner id as a substring", () => {
    const key = learnerDailyKey("learner-1", "2026-08-04");
    expect(key).not.toContain("learner-1");
  });

  // AT-AN-001-29: missing secret fails closed, never falls back to a
  // plain/predictable identifier.
  it("throws ANALYTICS_SECRET_MISSING and never derives a fallback key when the secret is absent", () => {
    delete process.env.ANALYTICS_HMAC_SECRET;
    expect(() => learnerDailyKey("learner-1", "2026-08-04")).toThrow(AnalyticsError);
    try {
      learnerDailyKey("learner-1", "2026-08-04");
    } catch (error) {
      expect((error as AnalyticsError).code).toBe("ANALYTICS_SECRET_MISSING");
    }
  });

  it("throws ANALYTICS_SECRET_MISSING when the secret is too short to be a real key", () => {
    process.env.ANALYTICS_HMAC_SECRET = "too-short";
    expect(() => learnerDailyKey("learner-1", "2026-08-04")).toThrow(AnalyticsError);
  });
});
