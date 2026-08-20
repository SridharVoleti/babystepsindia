import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
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

async function readRun(activityDate: string, db: DbClient = resolveDbClient()): Promise<RunRow> {
  return (await db.get<RunRow>("select * from analytics_daily_runs where activity_date = ?", [activityDate]))!;
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
export async function claimDailyRun(activityDate: string, now: Date): Promise<{ claimed: boolean; run: RunRow }> {
  // The SQLite adapter's transaction() uses a plain BEGIN (deferred), not
  // better-sqlite3's own .immediate() mode this used to rely on for
  // obtaining the write reservation up front — see src/lib/db-client's
  // sqlite-adapter.ts for why the native db.transaction() helper can't be
  // reused here (it rejects async callbacks). Postgres uses the
  // equivalent function in migration 0029 either way.
  return resolveDbClient().transaction(async (db) => {
    const inserted = await db.run(
      `insert into analytics_daily_runs(activity_date, status, run_version, started_at)
       values (?, 'running', 1, ?)
       on conflict(activity_date) do nothing`,
      [activityDate, now.toISOString()],
    );
    if (inserted.changes === 1) return { claimed: true, run: await readRun(activityDate, db) };

    const reclaimed = await db.run(
      `update analytics_daily_runs
     set status = 'running', run_version = run_version + 1, started_at = ?, completed_at = null, failure_code = null
     where activity_date = ? and status = 'failed'`,
      [now.toISOString(), activityDate],
    );
    return { claimed: reclaimed.changes === 1, run: await readRun(activityDate, db) };
  });
}

async function readBufferRows(activityDate: string): Promise<BufferRow[]> {
  const db = resolveDbClient();
  const rows = await db.all<{
    activity_date: string; learner_daily_key: string; app_id: string; level_key: string; age_band: AgeBand;
    engaged_seconds: number; sessions_started: number; sessions_completed: number;
    sessions_interrupted: number; lessons_completed: number;
  }>(
    `select activity_date, learner_daily_key, app_id, level_key, age_band,
            engaged_seconds, sessions_started, sessions_completed, sessions_interrupted, lessons_completed
     from analytics_daily_buffer where activity_date = ?`,
    [activityDate],
  );
  const result: BufferRow[] = [];
  for (const r of rows) {
    if (r.level_key !== "unassigned" && !(await db.get(
      "select 1 from app_analytics_levels where app_id=? and level_key=? and status='active'",
      [r.app_id, r.level_key],
    ))) throw new AnalyticsError("UNKNOWN_LEVEL_KEY");
    result.push({
      activityDate: r.activity_date, learnerDailyKey: r.learner_daily_key, appId: r.app_id, levelKey: r.level_key,
      ageBand: r.age_band, engagedSeconds: r.engaged_seconds, sessionsStarted: r.sessions_started,
      sessionsCompleted: r.sessions_completed, sessionsInterrupted: r.sessions_interrupted,
      lessonsCompleted: r.lessons_completed,
    });
  }
  return result;
}

// Business rule 20: exact replacement — every grain row for the date is
// rewritten from scratch inside one transaction, never incremented.
async function commitAggregates(
  activityDate: string,
  levelAggregates: ReturnType<typeof computeLevelAggregates>,
  appAggregates: ReturnType<typeof computeAppAggregates>,
  source: ReturnType<typeof computeControlTotals>,
  runVersion: number,
  now: Date,
): Promise<void> {
  const generatedAt = now.toISOString();
  await resolveDbClient().transaction(async (db) => {
    await db.run("delete from analytics_daily_level where activity_date = ?", [activityDate]);
    await db.run("delete from analytics_daily_app where activity_date = ?", [activityDate]);

    for (const a of levelAggregates) {
      await db.run(
        `insert into analytics_daily_level(
           activity_date, app_id, level_key, age_band, active_learners,
           sessions_started, sessions_completed, sessions_interrupted, engaged_seconds, lessons_completed,
           generated_at, run_version)
         values (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          a.activityDate, a.appId, a.levelKey, a.ageBand, a.activeLearners,
          a.sessionsStarted, a.sessionsCompleted, a.sessionsInterrupted, a.engagedSeconds, a.lessonsCompleted,
          generatedAt, runVersion,
        ],
      );
    }

    for (const a of appAggregates) {
      await db.run(
        `insert into analytics_daily_app(
           activity_date, app_id, age_band, active_learners,
           sessions_started, sessions_completed, sessions_interrupted, engaged_seconds, lessons_completed,
           generated_at, run_version)
         values (?,?,?,?,?,?,?,?,?,?,?)`,
        [
          a.activityDate, a.appId, a.ageBand, a.activeLearners,
          a.sessionsStarted, a.sessionsCompleted, a.sessionsInterrupted, a.engagedSeconds, a.lessonsCompleted,
          generatedAt, runVersion,
        ],
      );
    }

    await db.run(
      `update analytics_daily_runs set
         status = 'completed', run_version = ?, source_row_count = ?,
         source_engaged_seconds = ?, source_sessions_started = ?, source_sessions_completed = ?,
         source_sessions_interrupted = ?, source_lessons_completed = ?, completed_at = ?, failure_code = null
       where activity_date = ?`,
      [
        runVersion, source.sourceRowCount, source.engagedSeconds, source.sessionsStarted,
        source.sessionsCompleted, source.sessionsInterrupted, source.lessonsCompleted, generatedAt, activityDate,
      ],
    );
  });
}

async function markRunFailed(activityDate: string, failureCode: string, now: Date): Promise<void> {
  const db = resolveDbClient();
  await db.run(
    "update analytics_daily_runs set status = 'failed', completed_at = ?, failure_code = ? where activity_date = ?",
    [now.toISOString(), failureCode, activityDate],
  );
  await db.run(
    "insert into platform_alerts(id, alert_type, message, metadata) values (?, ?, ?, ?)",
    [
      randomUUID(),
      "analytics_run_failed",
      `Daily analytics run failed for ${activityDate} (${failureCode})`,
      JSON.stringify({ activityDate, failureCode }),
    ],
  );
}

// Business rule 25: buffer/receipt deletion only after the run is marked
// completed, and safe to retry independently of aggregate writes
// (AT-AN-001-30) — deleting rows that are already gone is a no-op.
export async function purgeDailyBuffer(activityDate: string): Promise<{ purged: boolean }> {
  const run = await readRun(activityDate);
  if (!run || run.status !== "completed") throw new AnalyticsError("RUN_NOT_COMPLETED");
  await resolveDbClient().transaction(async (db) => {
    await db.run("delete from analytics_daily_buffer where activity_date = ?", [activityDate]);
    await db.run("delete from analytics_contribution_receipts where activity_date = ?", [activityDate]);
  });
  return { purged: true };
}

// Orchestrates one date's run end to end (business rules 16-25). Safe to
// call repeatedly for the same date: a running/completed date returns its
// current state without reprocessing (AT-AN-001-10/13), a failed date is
// retried deterministically from the retained buffer (AT-AN-001-19), and
// a completed-but-not-yet-purged date has its purge retried (AT-AN-001-30).
export async function runDailyAggregation(activityDate: string, now: Date = new Date()): Promise<RunOutcome> {
  assertAnalyticsSecretConfigured();
  const claim = await claimDailyRun(activityDate, now);
  if (!claim.claimed) {
    if (claim.run.status === "completed") await purgeDailyBuffer(activityDate);
    return outcomeFromRow(await readRun(activityDate));
  }

  try {
    const bufferRows = await readBufferRows(activityDate);
    const levelAggregates = computeLevelAggregates(bufferRows);
    const appAggregates = computeAppAggregates(bufferRows);
    const sourceTotals = computeControlTotals(bufferRows);
    const verification = verifyControlTotals(sourceTotals, levelAggregates, appAggregates);
    if (!verification.ok) throw new AnalyticsError("CONTROL_TOTAL_MISMATCH");
    await commitAggregates(activityDate, levelAggregates, appAggregates, sourceTotals, claim.run.run_version, now);
  } catch (error) {
    const failureCode = error instanceof AnalyticsError ? error.code : "AGGREGATION_FAILED";
    await markRunFailed(activityDate, failureCode, now);
    return outcomeFromRow(await readRun(activityDate));
  }

  await purgeDailyBuffer(activityDate);
  return outcomeFromRow(await readRun(activityDate));
}
