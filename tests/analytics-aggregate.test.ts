import { describe, expect, it } from "vitest";
import {
  computeAppAggregates,
  computeControlTotals,
  computeLevelAggregates,
  verifyControlTotals,
  type BufferRow,
} from "@/lib/analytics/aggregate";

function row(overrides: Partial<BufferRow> = {}): BufferRow {
  return {
    activityDate: "2026-08-04",
    learnerDailyKey: "key-1",
    appId: "app-1",
    levelKey: "level-1",
    ageBand: "8_9",
    engagedSeconds: 60,
    sessionsStarted: 1,
    sessionsCompleted: 0,
    sessionsInterrupted: 0,
    lessonsCompleted: 0,
    ...overrides,
  };
}

// AT-AN-001-11: level aggregate correct, distinct learner count.
describe("computeLevelAggregates", () => {
  it("groups by date/app/level/age-band and sums counters", () => {
    const rows = [
      row({ learnerDailyKey: "a", engagedSeconds: 60, sessionsStarted: 1 }),
      row({ learnerDailyKey: "b", engagedSeconds: 30, sessionsStarted: 1 }),
    ];
    const result = computeLevelAggregates(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      activityDate: "2026-08-04", appId: "app-1", levelKey: "level-1", ageBand: "8_9",
      activeLearners: 2, engagedSeconds: 90, sessionsStarted: 2,
    });
  });

  it("counts active learners as distinct daily keys, not row count", () => {
    const rows = [
      row({ learnerDailyKey: "a", engagedSeconds: 60 }),
      row({ learnerDailyKey: "a", engagedSeconds: 0, sessionsCompleted: 1 }),
    ];
    // Same grain would already have been merged by the contribution repo,
    // but the aggregator itself must not assume that — verify distinct
    // counting holds even if two rows share a daily key.
    const result = computeLevelAggregates(rows);
    expect(result[0].activeLearners).toBe(1);
  });

  it("keeps different levels/age-bands as separate rows", () => {
    const rows = [
      row({ levelKey: "level-1" }),
      row({ levelKey: "level-2" }),
      row({ ageBand: "10_12" }),
    ];
    expect(computeLevelAggregates(rows)).toHaveLength(3);
  });
});

// AT-AN-001-12: app aggregate counts one learner once across levels.
describe("computeAppAggregates", () => {
  it("counts a learner spanning multiple levels once at app grain", () => {
    const rows = [
      row({ learnerDailyKey: "a", levelKey: "level-1", engagedSeconds: 60 }),
      row({ learnerDailyKey: "a", levelKey: "level-2", engagedSeconds: 40 }),
    ];
    const result = computeAppAggregates(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ activeLearners: 1, engagedSeconds: 100 });
  });

  it("keeps different age bands separate even for the same app", () => {
    const rows = [
      row({ learnerDailyKey: "a", ageBand: "8_9" }),
      row({ learnerDailyKey: "b", ageBand: "10_12" }),
    ];
    expect(computeAppAggregates(rows)).toHaveLength(2);
  });
});

// AT-AN-001-16: control totals match before deletion.
describe("computeControlTotals", () => {
  it("sums every counter across all buffer rows regardless of grain", () => {
    const rows = [
      row({ learnerDailyKey: "a", levelKey: "level-1", engagedSeconds: 60, sessionsStarted: 1 }),
      row({ learnerDailyKey: "b", levelKey: "level-2", engagedSeconds: 40, sessionsCompleted: 1 }),
    ];
    expect(computeControlTotals(rows)).toEqual({
      sourceRowCount: 2, engagedSeconds: 100, sessionsStarted: 2,
      sessionsCompleted: 1, sessionsInterrupted: 0, lessonsCompleted: 0,
    });
  });
});

describe("verifyControlTotals", () => {
  it("passes when level and app aggregate sums match the source", () => {
    const rows = [
      row({ learnerDailyKey: "a", levelKey: "level-1", engagedSeconds: 60, sessionsStarted: 1 }),
      row({ learnerDailyKey: "b", levelKey: "level-2", engagedSeconds: 40, sessionsCompleted: 1 }),
    ];
    const source = computeControlTotals(rows);
    const level = computeLevelAggregates(rows);
    const app = computeAppAggregates(rows);
    expect(verifyControlTotals(source, level, app)).toEqual({ ok: true, mismatches: [] });
  });

  // AT-AN-001-17: a mismatch must be detected and reported, not silently
  // accepted, so the caller can fail the run and retain the buffer.
  it("fails when a level aggregate total disagrees with the source", () => {
    const rows = [row({ engagedSeconds: 60 })];
    const source = computeControlTotals(rows);
    const level = computeLevelAggregates(rows).map((l) => ({ ...l, engagedSeconds: l.engagedSeconds + 1 }));
    const app = computeAppAggregates(rows);
    const result = verifyControlTotals(source, level, app);
    expect(result.ok).toBe(false);
    expect(result.mismatches.length).toBeGreaterThan(0);
  });

  it("fails when an app aggregate total disagrees with the source", () => {
    const rows = [row({ engagedSeconds: 60 })];
    const source = computeControlTotals(rows);
    const level = computeLevelAggregates(rows);
    const app = computeAppAggregates(rows).map((a) => ({ ...a, sessionsStarted: a.sessionsStarted + 1 }));
    const result = verifyControlTotals(source, level, app);
    expect(result.ok).toBe(false);
  });
});
