import { isSuperAdminDisplay } from "@/lib/staff-identity/roles";
import {
  listDailyAppAggregates, listDailyLevelAggregates,
  type AnalyticsDailyFilters, type DailyAppAggregateView, type DailyLevelAggregateView,
} from "@/lib/db/analytics-admin-repo";

// AN-004: "only Super Admin has unrestricted analytics/reporting access;
// every other role is explicitly scoped to least-privilege views, denied
// outside that scope." isSuperAdminDisplay (holding all 4 staff roles)
// was previously a UI-only label (src/lib/staff-identity/roles.ts) —
// this is its first use as a real authorization/scoping gate. Every
// other role that can reach this module at all today (only
// operations_administrator holds admin.analytics.daily.read/.export)
// gets app-level totals only; level-key breakdown is Super-Admin-only.
export const MIN_COHORT_SIZE = 5;
export type AnalyticsScope = "unrestricted" | "app_level";

export class AnalyticsScopeExceededError extends Error {
  constructor() {
    super("Requested filter is outside this role's approved analytics scope.");
    this.name = "AnalyticsScopeExceededError";
  }
}

const SUPPRESSIBLE_FIELDS = [
  "activeLearners", "sessionsStarted", "sessionsCompleted", "sessionsInterrupted", "engagedSeconds", "lessonsCompleted",
] as const;
type SuppressibleField = (typeof SUPPRESSIBLE_FIELDS)[number];

export type Suppressed<T> = Omit<T, SuppressibleField> & Record<SuppressibleField, number | null> & { suppressed: boolean };

// Rule: "minimum cohort size is 5" — below that, every count/duration
// field on the row is redacted, not just activeLearners, so no other
// field can be combined with a known-small headcount to re-identify a
// learner's activity.
function suppressCohort<T extends Record<SuppressibleField, number>>(row: T): Suppressed<T> {
  if (row.activeLearners >= MIN_COHORT_SIZE) {
    return { ...row, suppressed: false };
  }
  const redacted = { ...row } as Suppressed<T>;
  for (const field of SUPPRESSIBLE_FIELDS) redacted[field] = null;
  redacted.suppressed = true;
  return redacted;
}

export function resolveAnalyticsScope(roleKeys: readonly string[]): AnalyticsScope {
  return isSuperAdminDisplay(roleKeys) ? "unrestricted" : "app_level";
}

export type ScopedDailyAnalytics = {
  scope: AnalyticsScope;
  apps: Array<Suppressed<DailyAppAggregateView>>;
  levels: Array<Suppressed<DailyLevelAggregateView>> | null;
};

// Rule: cohorts below MIN_COHORT_SIZE are suppressed on every surface
// (API/UI/export) that reads through this function — there is no second
// code path reading analytics_daily_{app,level} directly for a staff
// consumer (both the route and the admin page compose through here).
export async function composeScopedDailyAnalytics(roleKeys: readonly string[], filters: AnalyticsDailyFilters): Promise<ScopedDailyAnalytics> {
  const scope = resolveAnalyticsScope(roleKeys);
  if (scope === "app_level" && filters.levelKey) {
    throw new AnalyticsScopeExceededError();
  }
  const apps = (await listDailyAppAggregates(filters)).map(suppressCohort);
  if (scope === "app_level") {
    return { scope, apps, levels: null };
  }
  const levels = (await listDailyLevelAggregates(filters)).map(suppressCohort);
  return { scope, apps, levels };
}

const APP_CSV_COLUMNS = [
  "activityDate", "appKey", "appDisplayName", "ageBand", "activeLearners",
  "sessionsStarted", "sessionsCompleted", "sessionsInterrupted", "engagedSeconds", "lessonsCompleted", "suppressed",
] as const;
const LEVEL_CSV_COLUMNS = [
  "activityDate", "appKey", "appDisplayName", "levelKey", "ageBand", "activeLearners",
  "sessionsStarted", "sessionsCompleted", "sessionsInterrupted", "engagedSeconds", "lessonsCompleted", "suppressed",
] as const;

function toCsv<T extends Record<string, unknown>>(rows: T[], columns: readonly (keyof T)[]): string {
  const header = columns.join(",");
  const lines = rows.map((row) => columns.map((col) => String(row[col] ?? "")).join(","));
  return [header, ...lines].join("\n");
}

// AT-AN-004-03: export inherits the exact same scope/filters/suppression
// as the interactive view — a thin CSV rendering over the same compose
// function, never a second, unsuppressed export path.
export async function composeScopedDailyAnalyticsCsv(roleKeys: readonly string[], filters: AnalyticsDailyFilters): Promise<string> {
  const result = await composeScopedDailyAnalytics(roleKeys, filters);
  if (filters.levelKey && result.levels) {
    return toCsv(result.levels, LEVEL_CSV_COLUMNS);
  }
  return toCsv(result.apps, APP_CSV_COLUMNS);
}
