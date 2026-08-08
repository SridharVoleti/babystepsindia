import { describe, expect, it } from "vitest";
import { isStrictCalendarDate } from "@/lib/analytics/calendar-date";

describe("isStrictCalendarDate", () => {
  it.each(["2026-01-01", "2026-12-31", "2024-02-29", "2000-02-29"])(
    "accepts real canonical calendar date %s",
    (value) => expect(isStrictCalendarDate(value)).toBe(true),
  );

  it.each([
    "2026-02-29",
    "1900-02-29",
    "2026-04-31",
    "2026-06-31",
    "2026-00-10",
    "2026-13-01",
    "2026-01-00",
    "0000-01-01",
    "2026-1-01",
    "2026-01-1",
    "2026-01-01T00:00:00Z",
    " 2026-01-01",
    "",
  ])("rejects malformed or impossible calendar date %s", (value) => {
    expect(isStrictCalendarDate(value)).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isStrictCalendarDate(undefined)).toBe(false);
    expect(isStrictCalendarDate(null)).toBe(false);
    expect(isStrictCalendarDate(new Date("2026-01-01"))).toBe(false);
  });
});
