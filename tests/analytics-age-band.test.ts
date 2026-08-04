import { describe, expect, it } from "vitest";
import { deriveAgeBand } from "@/lib/analytics/age-band";

// AT-AN-001-06: age band at activity date, DOB boundary cases; exact age
// is never returned — only the approved band.
describe("deriveAgeBand", () => {
  it.each([
    ["2021-01-01", "2026-08-04", "under_6"], // 5y
    ["2020-08-04", "2026-08-04", "6_7"], // exactly 6y today
    ["2018-08-04", "2026-08-04", "8_9"], // exactly 8y today
    ["2016-08-04", "2026-08-04", "10_12"], // exactly 10y today
    ["2013-08-04", "2026-08-04", "13_15"], // exactly 13y today
    ["2010-08-04", "2026-08-04", "16_18"], // exactly 16y today
    ["2007-08-04", "2026-08-04", "19_29"], // exactly 19y today
    ["1990-08-04", "2026-08-04", "30_49"], // exactly 36y today
    ["1970-08-04", "2026-08-04", "50_plus"], // exactly 56y today
  ])("dob %s as of %s -> %s", (dob, activityDate, expected) => {
    expect(deriveAgeBand(dob, activityDate)).toBe(expected);
  });

  it("resolves the boundary the day before a birthday to the lower band", () => {
    // Turns 6 on 2026-08-04; the day before, still 5.
    expect(deriveAgeBand("2020-08-04", "2026-08-03")).toBe("under_6");
  });

  it("never leaks an exact age value — only a band string is returned", () => {
    const band = deriveAgeBand("2020-08-04", "2026-08-04");
    expect(typeof band).toBe("string");
    expect(band).not.toMatch(/^\d+$/);
  });
});
