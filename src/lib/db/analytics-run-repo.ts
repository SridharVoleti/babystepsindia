import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { AnalyticsError } from "@/lib/analytics/errors";
import {
  computeAppAggregates,
  computeControlTotals,
  computeLevelAggregates,
  verifyControlTotals,
  type BufferRow,
} from "@/lib/analytics/aggregate";
import type { AgeBand, AnalyticsRunStatus } from "@/lib/db/types";
import { assertAnalyticsSecretConfigured } from "@/lib/analytics/daily-key";

type RunRow = {
  activity_date: string;
  status: AnalyticsRunStatus;
  run_version: number;
  source_row_count: number;
  source_engaged_seconds: number;
  source_sessions_started: number;
  source_sessions_completed: number;
  source_sessions_interrupted: number;
  source_lessons_completed: number;
  started_at: string;
  completed_at: string | null;
  failure_code: string | null;
};

export type RunOutcome = {
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

function readRun(activityDate: string): RunRow {
  return getDb().prepare("select * from analytics_daily_runs where activity_date = ?").get(activityDate) as RunRow;
}

function outcomeFromRow(row: RunRow): RunOutcome {
  return {
    activityDate: row.activity_date,
    status: row.status,
    runVersion: row.run_version,
    sourceRowCount: row.source_row_count,
    controlTotals: {
      engagedSeconds: row.source_engaged_seconds,
      sessionsStarted: row.source_sessions_started,
      sessionsCompleted: row.source_sessions_completed,
      sessionsInterrupted: row.source_sessions_interrupted,
      lessonsCompleted: row.source_lessons_completed,
    },
    startedAt: row.started_at,
    completedAt: row.completed_at,
    failureCode: row.failure_code,
  };
}

// Business rules 16/17: single-date lock via analytics_daily_runs itself.
// A missing row is claimed outright; a 'running' or 'completed' row is
// left untouched (AT-AN-001-10); a 'failed' row is reclaimed for retry
// (business rule 21/AT-AN-001-19) with run_version bumped.
export function claimDailyRun(activityDate: string, now: Date): { claimed: boolean; run: RunRow } {
  const db = getDb();
  const claim = db.transaction(() => {
    const inserted = db.prepare(
      `insert into analytics_daily_runs(activity_date, status, run_version, started_at)
       values (?, 'running', 1, ?)
       on conflict(activity_date) do nothing`,
    ).run(activityDate, now.toISOString());
    if (inserted.changes === 1) return { claimed: true, run: readRun(activityDate) };

    const reclaimed = db.prepare(
    `update analytics_daily_runs
     set status = 'running', run_version = run_version + 1, started_at = ?, completed_at = null, failure_code = null
     where activity_date = ? and status = 'failed'`,
  ).run(now.toISOString(), activityDate);
    return { claimed: reclaimed.changes === 1, run: readRun(activityDate) };
  });
  // IMMEDIATE obtains SQLite's write reservation before inspecting or
  // changing the claim row, so separate processes cannot both reclaim a
  // failed version. Postgres uses the equivalent function in migration 0029.
  return claim.immediate();
}

function readBufferRows(activityDate: string): BufferRow[] {
  const rows = getDb().prepare(
    `select activity_date, learner_daily_key, app_id, level_key, age_band,
            engaged_seconds, sessions_started, sessions_completed, sessions_interrupted, lessons_completed
     from analytics_daily_buffer where activity_date = ?`,
  ).all(activityDate) as Array<{
    activity_date: string; learner_daily_key: string; app_id: string; level_key: string; age_band: AgeBand;
    engaged_seconds: number; sessions_started: number; sessions_completed: number;
    sessions_interrupted: number; lessons_completed: number;
  }>;
  return rows.map((r) => {
    if (r.level_key !== "unassigned" && !getDb().prepare(
      "select 1 from app_analytics_levels where app_id=? and level_key=? and status='active'",
    ).get(r.app_id, r.level_key)) throw new AnalyticsError("UNKNOWN_LEVEL_KEY");
    return {
      activityDate: r.activity_date, learnerDailyKey: r.learner_daily_key, appId: r.app_id, levelKey: r.level_key,
      ageBand: r.age_band, engagedSeconds: r.engaged_seconds, sessionsStarted: r.sessions_started,
      sessionsCompleted: r.sessions_completed, sessionsInterrupted: r.sessions_interrupted,
      lessonsCompleted: r.lessons_completed,
    };
  });
}

// Business rule 20: exact replacement — every grain row for the date is
// rewritten from scratch inside one transaction, never incremented.
function commitAggregates(
  activityDate: string,
  levelAggregates: ReturnType<typeof computeLevelAggregates>,
  appAggregates: ReturnType<typeof computeAppAggregates>,
  source: ReturnType<typeof computeControlTotals>,
  runVersion: number,
  now: Date,
): void {
  const db = getDb();
  const generatedAt = now.toISOString();
  const run = db.transaction(() => {
    db.prepare("delete from analytics_daily_level where activity_date = ?").run(activityDate);
    db.prepare("delete from analytics_daily_app where activity_date = ?").run(activityDate);

    const insertLevel = db.prepare(
      `insert into analytics_daily_level(
         activity_date, app_id, level_key, age_band, active_learners,
         sessions_started, sessions_completed, sessions_interrupted, engaged_seconds, lessons_completed,
         generated_at, run_version)
       values (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const a of levelAggregates) {
      insertLevel.run(
        a.activityDate, a.appId, a.levelKey, a.ageBand, a.activeLearners,
        a.sessionsStarted, a.sessionsCompleted, a.sessionsInterrupted, a.engagedSeconds, a.lessonsCompleted,
        generatedAt, runVersion,
      );
    }

    const insertApp = db.prepare(
      `insert into analytics_daily_app(
         activity_date, app_id, age_band, active_learners,
         sessions_started, sessions_completed, sessions_interrupted, engaged_seconds, lessons_completed,
         generated_at, run_version)
       values (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const a of appAggregates) {
      insertApp.run(
        a.activityDate, a.appId, a.ageBand, a.activeLearners,
        a.sessionsStarted, a.sessionsCompleted, a.sessionsInterrupted, a.engagedSeconds, a.lessonsCompleted,
        generatedAt, runVersion,
      );
    }

    db.prepare(
      `update analytics_daily_runs set
         status = 'completed', run_version = ?, source_row_count = ?,
         source_engaged_seconds = ?, source_sessions_started = ?, source_sessions_completed = ?,
         source_sessions_interrupted = ?, source_lessons_completed = ?, completed_at = ?, failure_code = null
       where activity_date = ?`,
    ).run(
      runVersion, source.sourceRowCount, source.engagedSeconds, source.sessionsStarted,
      source.sessionsCompleted, source.sessionsInterrupted, source.lessonsCompleted, generatedAt, activityDate,
    );
  });
  run();
}

function markRunFailed(activityDate: string, failureCode: string, now: Date): void {
  const db = getDb();
  db.prepare(
    "update analytics_daily_runs set status = 'failed', completed_at = ?, failure_code = ? where activity_date = ?",
  ).run(now.toISOString(), failureCode, activityDate);
  db.prepare(
    "insert into platform_alerts(id, alert_type, message, metadata) values (?, ?, ?, ?)",
  ).run(
    randomUUID(),
    "analytics_run_failed",
    `Daily analytics run failed for ${activityDate} (${failureCode})`,
    JSON.stringify({ activityDate, failureCode }),
  );
}

// Business rule 25: buffer/receipt deletion only after the run is marked
// completed, and safe to retry independently of aggregate writes
// (AT-AN-001-30) — deleting rows that are already gone is a no-op.
export function purgeDailyBuffer(activityDate: string): { purged: boolean } {
  const db = getDb();
  const run = readRun(activityDate);
  if (!run || run.status !== "completed") throw new AnalyticsError("RUN_NOT_COMPLETED");
  const txn = db.transaction(() => {
    db.prepare("delete from analytics_daily_buffer where activity_date = ?").run(activityDate);
    db.prepare("delete from analytics_contribution_receipts where activity_date = ?").run(activityDate);
  });
  txn();
  return { purged: true };
}

// Orchestrates one date's run end to end (business rules 16-25). Safe to
// call repeatedly for the same date: a running/completed date returns its
// current state without reprocessing (AT-AN-001-10/13), a failed date is
// retried deterministically from the retained buffer (AT-AN-001-19), and
// a completed-but-not-yet-purged date has its purge retried (AT-AN-001-30).
export function runDailyAggregation(activityDate: string, now: Date = new Date()): RunOutcome {
  assertAnalyticsSecretConfigured();
  const claim = claimDailyRun(activityDate, now);
  if (!claim.claimed) {
    if (claim.run.status === "completed") purgeDailyBuffer(activityDate);
    return outcomeFromRow(readRun(activityDate));
  }

  try {
    const bufferRows = readBufferRows(activityDate);
    const levelAggregates = computeLevelAggregates(bufferRows);
    const appAggregates = computeAppAggregates(bufferRows);
    const sourceTotals = computeControlTotals(bufferRows);
    const verification = verifyControlTotals(sourceTotals, levelAggregates, appAggregates);
    if (!verification.ok) throw new AnalyticsError("CONTROL_TOTAL_MISMATCH");
    commitAggregates(activityDate, levelAggregates, appAggregates, sourceTotals, claim.run.run_version, now);
  } catch (error) {
    const failureCode = error instanceof AnalyticsError ? error.code : "AGGREGATION_FAILED";
    markRunFailed(activityDate, failureCode, now);
    return outcomeFromRow(readRun(activityDate));
  }

  purgeDailyBuffer(activityDate);
  return outcomeFromRow(readRun(activityDate));
}
