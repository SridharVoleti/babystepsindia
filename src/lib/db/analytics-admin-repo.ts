import { resolveDbClient } from "@/lib/db-client";
import type { AgeBand, AnalyticsRunStatus } from "@/lib/db/types";

export type DailyLevelAggregateView = {
  activityDate: string;
  appId: string;
  appKey: string;
  appDisplayName: string;
  levelKey: string;
  ageBand: AgeBand;
  activeLearners: number;
  sessionsStarted: number;
  sessionsCompleted: number;
  sessionsInterrupted: number;
  engagedSeconds: number;
  lessonsCompleted: number;
};

export type DailyAppAggregateView = Omit<DailyLevelAggregateView, "levelKey">;

export type AnalyticsDailyFilters = {
  from?: string;
  to?: string;
  appId?: string;
  levelKey?: string;
  ageBand?: string;
};

function buildWhere(filters: AnalyticsDailyFilters, alias: string, includeLevel: boolean) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.from) { clauses.push(`${alias}.activity_date >= ?`); params.push(filters.from); }
  if (filters.to) { clauses.push(`${alias}.activity_date <= ?`); params.push(filters.to); }
  if (filters.appId) { clauses.push(`${alias}.app_id = ?`); params.push(filters.appId); }
  if (includeLevel && filters.levelKey) { clauses.push(`${alias}.level_key = ?`); params.push(filters.levelKey); }
  if (filters.ageBand) { clauses.push(`${alias}.age_band = ?`); params.push(filters.ageBand); }
  return { where: clauses.length ? `where ${clauses.join(" and ")}` : "", params };
}

// AC22: aggregates reference the permanent app_id and remain resolvable
// through AR-001 identity (appKey/displayName) even after the app is
// soft-deleted — the join is unrestricted by registry_status.
export async function listDailyLevelAggregates(filters: AnalyticsDailyFilters): Promise<DailyLevelAggregateView[]> {
  const { where, params } = buildWhere(filters, "a", true);
  const rows = await resolveDbClient().all<Record<string, unknown>>(
    `select a.*, r.app_key, r.display_name
     from analytics_daily_level a
     join app_registry r on r.id = a.app_id
     join analytics_daily_runs run on run.activity_date = a.activity_date and run.status = 'completed'
     ${where}
     order by a.activity_date desc, r.display_name, a.level_key, a.age_band`,
    params as never[],
  );
  return rows.map((row) => ({
    activityDate: row.activity_date as string,
    appId: row.app_id as string,
    appKey: row.app_key as string,
    appDisplayName: row.display_name as string,
    levelKey: row.level_key as string,
    ageBand: row.age_band as AgeBand,
    activeLearners: row.active_learners as number,
    sessionsStarted: row.sessions_started as number,
    sessionsCompleted: row.sessions_completed as number,
    sessionsInterrupted: row.sessions_interrupted as number,
    engagedSeconds: row.engaged_seconds as number,
    lessonsCompleted: row.lessons_completed as number,
  }));
}

export async function listDailyAppAggregates(filters: AnalyticsDailyFilters): Promise<DailyAppAggregateView[]> {
  const { where, params } = buildWhere(filters, "a", false);
  const rows = await resolveDbClient().all<Record<string, unknown>>(
    `select a.*, r.app_key, r.display_name
     from analytics_daily_app a
     join app_registry r on r.id = a.app_id
     join analytics_daily_runs run on run.activity_date = a.activity_date and run.status = 'completed'
     ${where}
     order by a.activity_date desc, r.display_name, a.age_band`,
    params as never[],
  );
  return rows.map((row) => ({
    activityDate: row.activity_date as string,
    appId: row.app_id as string,
    appKey: row.app_key as string,
    appDisplayName: row.display_name as string,
    ageBand: row.age_band as AgeBand,
    activeLearners: row.active_learners as number,
    sessionsStarted: row.sessions_started as number,
    sessionsCompleted: row.sessions_completed as number,
    sessionsInterrupted: row.sessions_interrupted as number,
    engagedSeconds: row.engaged_seconds as number,
    lessonsCompleted: row.lessons_completed as number,
  }));
}

export type RunSummaryView = {
  activityDate: string;
  status: AnalyticsRunStatus;
  runVersion: number;
  sourceRowCount: number;
  controlTotals: {
    engagedSeconds: number;
    sessionsStarted: number;
    sessionsCompleted: number;
    sessionsInterrupted: number;
    lessonsCompleted: number;
  };
  startedAt: string;
  completedAt: string | null;
  failureCode: string | null;
};

// AC20/AC32: run tracking exposed to admins carries only status/control
// totals — never learner information — and callers can tell an
// incomplete date apart from a completed one.
export async function listDailyRuns(filters: { from?: string; to?: string } = {}): Promise<RunSummaryView[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters.from) { clauses.push("activity_date >= ?"); params.push(filters.from); }
  if (filters.to) { clauses.push("activity_date <= ?"); params.push(filters.to); }
  const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
  const rows = await resolveDbClient().all<Record<string, unknown>>(
    `select * from analytics_daily_runs ${where} order by activity_date desc`,
    params as never[],
  );
  return rows.map((row) => ({
    activityDate: row.activity_date as string,
    status: row.status as AnalyticsRunStatus,
    runVersion: row.run_version as number,
    sourceRowCount: row.source_row_count as number,
    controlTotals: {
      engagedSeconds: row.source_engaged_seconds as number,
      sessionsStarted: row.source_sessions_started as number,
      sessionsCompleted: row.source_sessions_completed as number,
      sessionsInterrupted: row.source_sessions_interrupted as number,
      lessonsCompleted: row.source_lessons_completed as number,
    },
    startedAt: row.started_at as string,
    completedAt: row.completed_at as string | null,
    failureCode: row.failure_code as string | null,
  }));
}
