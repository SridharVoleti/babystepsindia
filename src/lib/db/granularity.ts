import { isPostgresBackend } from "@/lib/db-client";

// REQ-08 §8 revenue/growth reporting buckets. Shared by payments.ts and
// subscriptions.ts, which used to each keep their own identical copy of
// this SQLite-only expression map — strftime() doesn't exist on Postgres
// (production crash: "function strftime(unknown, timestamp with time
// zone) does not exist"), so this now picks dialect-appropriate SQL text
// per backend rather than computing the bucket in JS (the values are
// GROUP BY expressions evaluated inside the query itself, not read back
// afterward, so there's no portable "compute in JS" alternative here).

export type Granularity = "day" | "week" | "month" | "quarter" | "year";

const SQLITE_GRANULARITY_EXPR: Record<Granularity, string> = {
  day: "strftime('%Y-%m-%d', %COL%)",
  week: "strftime('%Y-W%W', %COL%)",
  month: "strftime('%Y-%m', %COL%)",
  quarter:
    "strftime('%Y', %COL%) || '-Q' || ((cast(strftime('%m', %COL%) as integer) - 1) / 3 + 1)",
  year: "strftime('%Y', %COL%)",
};

// %W (SQLite, Monday-based week-of-year) and IW (Postgres, ISO-8601 week)
// can disagree by a day near year boundaries — an accepted difference for
// a reporting bucket label, not a value read back and compared elsewhere.
const POSTGRES_GRANULARITY_EXPR: Record<Granularity, string> = {
  day: "to_char(%COL%, 'YYYY-MM-DD')",
  week: `to_char(%COL%, 'IYYY-"W"IW')`,
  month: "to_char(%COL%, 'YYYY-MM')",
  quarter: `to_char(%COL%, 'YYYY"-Q"Q')`,
  year: "to_char(%COL%, 'YYYY')",
};

export function granularityExpr(granularity: Granularity, column: string): string {
  const map = isPostgresBackend() ? POSTGRES_GRANULARITY_EXPR : SQLITE_GRANULARITY_EXPR;
  return map[granularity].replaceAll("%COL%", column);
}
