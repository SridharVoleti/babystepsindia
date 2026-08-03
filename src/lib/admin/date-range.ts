import type { Granularity } from "@/lib/db/subscriptions";

const VALID_GRANULARITIES: Granularity[] = [
  "day",
  "week",
  "month",
  "quarter",
  "year",
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type ParsedDateRange = {
  fromDate: string; // yyyy-mm-dd, for <input type="date">
  toDate: string;
  granularity: Granularity;
  fromISO: string; // sqlite-comparable, inclusive
  toISO: string; // sqlite-comparable, exclusive
};

export function parseDateRange(searchParams: {
  from?: string;
  to?: string;
  granularity?: string;
}): ParsedDateRange {
  const granularity = VALID_GRANULARITIES.includes(
    searchParams.granularity as Granularity,
  )
    ? (searchParams.granularity as Granularity)
    : "month";

  const today = new Date();
  const defaultToDate = isoDate(today);
  const sixMonthsAgo = new Date(today);
  sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
  const defaultFromDate = isoDate(sixMonthsAgo);

  const fromDate = searchParams.from || defaultFromDate;
  const toDate = searchParams.to || defaultToDate;

  const toExclusive = new Date(`${toDate}T00:00:00.000Z`);
  toExclusive.setUTCDate(toExclusive.getUTCDate() + 1);

  return {
    fromDate,
    toDate,
    granularity,
    fromISO: `${fromDate} 00:00:00`,
    toISO: `${isoDate(toExclusive)} 00:00:00`,
  };
}

// Same-length window immediately preceding `fromISO`, for the stat-tile
// delta ("vs previous period").
export function previousRange(range: ParsedDateRange): {
  fromISO: string;
  toISO: string;
} {
  const from = new Date(`${range.fromDate}T00:00:00.000Z`);
  const to = new Date(`${range.toDate}T00:00:00.000Z`);
  const spanMs = to.getTime() - from.getTime();

  const prevTo = new Date(from);
  const prevFrom = new Date(from.getTime() - spanMs - 24 * 60 * 60 * 1000);

  return {
    fromISO: `${isoDate(prevFrom)} 00:00:00`,
    toISO: `${isoDate(prevTo)} 00:00:00`,
  };
}
