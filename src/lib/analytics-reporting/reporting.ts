import { authorizeAnalyticsView, type AnalyticsActor } from "./access";

export const MIN_ANALYTICS_COHORT = 5;

export type AggregateAnalyticsRow = {
  activityDate: string;
  appId: string;
  levelKey?: string;
  ageBand: string;
  activeLearners: number;
  sessionsStarted: number;
  sessionsCompleted: number;
  engagedSeconds: number;
  lessonsCompleted: number;
};

export function applyCohortSuppression(rows: AggregateAnalyticsRow[]): AggregateAnalyticsRow[] {
  return rows.filter((row) => row.activeLearners >= MIN_ANALYTICS_COHORT);
}

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportAggregateCsv(input: {
  actor: AnalyticsActor;
  rows: AggregateAnalyticsRow[];
  request: { appId?: string; levelKey?: string; ageBand?: string };
}): string {
  const authorization = authorizeAnalyticsView(input.actor, { ...input.request, exportRequested: true });
  if (!authorization.allowed) throw new Error(authorization.reason);

  const filtered = applyCohortSuppression(input.rows.filter((row) =>
    (!input.request.appId || row.appId === input.request.appId)
    && (!input.request.levelKey || row.levelKey === input.request.levelKey)
    && (!input.request.ageBand || row.ageBand === input.request.ageBand),
  ));

  const header = ["activity_date", "app_id", "level_key", "age_band", "active_learners", "sessions_started", "sessions_completed", "engaged_seconds", "lessons_completed"];
  return [
    header.join(","),
    ...filtered.map((row) => [
      row.activityDate, row.appId, row.levelKey ?? "", row.ageBand, row.activeLearners,
      row.sessionsStarted, row.sessionsCompleted, row.engagedSeconds, row.lessonsCompleted,
    ].map(csvCell).join(",")),
  ].join("\n");
}
