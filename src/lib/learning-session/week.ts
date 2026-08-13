import { calendarDateInTimeZone } from "@/lib/learner-profile/date";

export function isoWeekKey(now: Date, timezone: string): string {
  const localDate = calendarDateInTimeZone(timezone, now);
  const [year, month, day] = localDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const first = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil((((date.getTime() - first.getTime()) / 86400000) + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

function timeZoneOffsetMinutes(timezone: string, at: Date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
  return (asUtc - at.getTime()) / 60_000;
}

function localMidnightToUtc(timezone: string, year: number, monthIndex: number, day: number) {
  const localAsUtc = new Date(Date.UTC(year, monthIndex, day));
  return new Date(localAsUtc.getTime() - timeZoneOffsetMinutes(timezone, localAsUtc) * 60_000);
}

/** The exact Monday-to-Monday window used by isoWeekKey, expressed as UTC instants. */
export function isoWeekBounds(weekKey: string, timezone: string) {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!match) throw new Error("WEEKLY_KEY_INVALID");
  const isoYear = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) throw new Error("WEEKLY_KEY_INVALID");
  const januaryFourth = new Date(Date.UTC(isoYear, 0, 4));
  const weekday = januaryFourth.getUTCDay() || 7;
  const monday = new Date(Date.UTC(isoYear, 0, 4 - weekday + 1 + (week - 1) * 7));
  const endMonday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 7));
  const startAt = localMidnightToUtc(timezone, monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate());
  const endAt = localMidnightToUtc(timezone, endMonday.getUTCFullYear(), endMonday.getUTCMonth(), endMonday.getUTCDate());
  if (isoWeekKey(new Date(startAt.getTime() + 12 * 60 * 60_000), timezone) !== weekKey) {
    throw new Error("WEEKLY_KEY_INVALID");
  }
  return { weeklyKey: weekKey, timezone, startAt, endAt };
}

export function currentIsoWeekBounds(now: Date, timezone: string) {
  return isoWeekBounds(isoWeekKey(now, timezone), timezone);
}
