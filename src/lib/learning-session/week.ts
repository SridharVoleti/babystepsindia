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
