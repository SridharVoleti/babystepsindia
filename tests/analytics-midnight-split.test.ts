import { describe, expect, it } from "vitest";
import { splitKolkataEngagedSeconds } from "@/lib/analytics/kolkata-interval";

describe("AN-001 Kolkata engaged-time splitting (AT-AN-001-14)", () => {
  it("splits a connected interval on the Asia/Kolkata midnight boundary", () => {
    expect(splitKolkataEngagedSeconds(new Date("2026-08-04T18:29:30.000Z"), 60)).toEqual([
      { activityDate: "2026-08-04", engagedSeconds: 30 },
      { activityDate: "2026-08-05", engagedSeconds: 30 },
    ]);
  });

  it("keeps an interval beginning exactly at midnight on the new local date", () => {
    expect(splitKolkataEngagedSeconds(new Date("2026-08-04T18:30:00.000Z"), 60)).toEqual([
      { activityDate: "2026-08-05", engagedSeconds: 60 },
    ]);
  });

  it("preserves every accepted second and handles month/year rollover", () => {
    const chunks = splitKolkataEngagedSeconds(new Date("2026-12-31T18:29:40.000Z"), 90);
    expect(chunks).toEqual([
      { activityDate: "2026-12-31", engagedSeconds: 20 },
      { activityDate: "2027-01-01", engagedSeconds: 70 },
    ]);
    expect(chunks.reduce((sum, chunk) => sum + chunk.engagedSeconds, 0)).toBe(90);
  });

  it("returns no contribution for zero accepted seconds", () => {
    expect(splitKolkataEngagedSeconds(new Date("2026-08-04T18:29:30.000Z"), 0)).toEqual([]);
  });
});
