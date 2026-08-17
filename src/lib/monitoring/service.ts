import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";

// AN-002: the minimal operational-monitoring projection. Reads (never
// writes to) each critical job's own scattered *_job_runs/*_sweep_runs
// table and copies a normalized, safe snapshot into this module's own
// storage — observational only, never authoritative, and structurally
// unable to mutate billing/access/session/progress truth since it never
// issues an update/delete against any source-domain table.
export type MonitoringStatus = "completed" | "failed" | "running";

type SourceRow = {
  sourceRunKey: string; status: MonitoringStatus; runAt: string; durationMs: number | null;
  counts: Record<string, number>; correlationId: string | null;
};

// Rule: "Provider-native infrastructure observability wherever
// sufficient" — this registry covers a representative subset of the
// clearest "critical operations" (billing, entitlement lifecycle,
// notification delivery, progress-integrity sweep), not every scattered
// job-run table in the codebase. Extending coverage to another job is
// adding one more registry entry, not new machinery.
const JOB_SOURCES: Record<string, () => SourceRow[]> = {
  billing_reconcile: () => latestJobRunRows("billing_job_runs", "reconcile"),
  billing_renewal_reminder: () => latestJobRunRows("billing_job_runs", "renewal_reminder"),
  entitlement_lifecycle_sweep: () => latestJobRunRows("entitlement_lifecycle_job_runs", "sweep"),
  entitlement_lifecycle_reconcile: () => latestJobRunRows("entitlement_lifecycle_job_runs", "reconcile"),
  notification_delivery: () => latestRunStateRows("notification_delivery_runs"),
  notification_reconcile: () => latestRunStateRows("notification_reconcile_runs"),
  progress_integrity_sweep: () => latestProgressIntegritySweepRows(),
};

function latestJobRunRows(table: "billing_job_runs" | "entitlement_lifecycle_job_runs", jobType: string): SourceRow[] {
  const rows = getDb().prepare(
    `select run_idempotency_key, status, created_at, completed_at from ${table}
     where job_type=? order by created_at desc limit 5`,
  ).all(jobType) as Array<{ run_idempotency_key: string; status: string; created_at: string; completed_at: string | null }>;
  return rows.map((row) => ({
    sourceRunKey: row.run_idempotency_key,
    status: row.status === "completed" ? "completed" : row.status === "failed" ? "failed" : "running",
    runAt: row.created_at,
    durationMs: row.completed_at ? new Date(row.completed_at).getTime() - new Date(row.created_at).getTime() : null,
    counts: {},
    correlationId: row.run_idempotency_key,
  }));
}

function latestRunStateRows(table: "notification_delivery_runs" | "notification_reconcile_runs"): SourceRow[] {
  const rows = getDb().prepare(
    `select run_idempotency_key, state, created_at, updated_at from ${table} order by created_at desc limit 5`,
  ).all() as Array<{ run_idempotency_key: string; state: string; created_at: string; updated_at: string }>;
  return rows.map((row) => ({
    sourceRunKey: row.run_idempotency_key,
    status: row.state === "completed" ? "completed" : "running",
    runAt: row.created_at,
    durationMs: row.updated_at ? new Date(row.updated_at).getTime() - new Date(row.created_at).getTime() : null,
    counts: {},
    correlationId: row.run_idempotency_key,
  }));
}

function latestProgressIntegritySweepRows(): SourceRow[] {
  const rows = getDb().prepare(
    `select run_idempotency_key, cursor, processed, incidents_opened, repairs_applied, created_at
     from progress_integrity_sweep_runs order by created_at desc limit 5`,
  ).all() as Array<{ run_idempotency_key: string; cursor: string; processed: number;
    incidents_opened: number; repairs_applied: number; created_at: string }>;
  return rows.map((row) => ({
    sourceRunKey: `${row.run_idempotency_key}:${row.cursor}`,
    status: "completed",
    runAt: row.created_at,
    durationMs: null,
    counts: { processed: row.processed, incidentsOpened: row.incidents_opened, repairsApplied: row.repairs_applied },
    correlationId: row.run_idempotency_key,
  }));
}

// Copies up to the 5 most recent rows per registered job into this
// module's own snapshot table — idempotent via unique(job_key,
// source_run_key), so re-running the sync never duplicates a row.
export function syncMonitoringSnapshots(now: Date = new Date()): { synced: number } {
  const db = getDb();
  const timestamp = now.toISOString();
  let synced = 0;
  for (const [jobKey, fetchRows] of Object.entries(JOB_SOURCES)) {
    for (const row of fetchRows()) {
      const result = db.prepare(
        `insert into monitoring_job_snapshots
         (id,job_key,source_run_key,status,run_at,duration_ms,counts_json,correlation_id,created_at)
         values (?,?,?,?,?,?,?,?,?)
         on conflict(job_key,source_run_key) do nothing`,
      ).run(randomUUID(), jobKey, row.sourceRunKey, row.status, row.runAt, row.durationMs,
        JSON.stringify(row.counts), row.correlationId, timestamp);
      if (result.changes > 0) synced += 1;
    }
  }
  return { synced };
}

export type JobOperationalStatus = {
  jobKey: string; status: MonitoringStatus | "unknown"; lastRunAt: string | null;
  durationMs: number | null; counts: Record<string, number>; correlationId: string | null;
};

// Rule: "Critical jobs expose last run/status/counts" — reads only from
// this module's own snapshot table, never the source-domain tables
// directly, so a caller of this function can never accidentally observe
// (or be coupled to) a source table's own internal shape.
export function getOperationalStatus(): JobOperationalStatus[] {
  const db = getDb();
  return Object.keys(JOB_SOURCES).map((jobKey) => {
    const row = db.prepare(
      "select status, run_at, duration_ms, counts_json, correlation_id from monitoring_job_snapshots where job_key=? order by run_at desc limit 1",
    ).get(jobKey) as { status: MonitoringStatus; run_at: string; duration_ms: number | null;
      counts_json: string; correlation_id: string | null } | undefined;
    if (!row) return { jobKey, status: "unknown" as const, lastRunAt: null, durationMs: null, counts: {}, correlationId: null };
    return { jobKey, status: row.status, lastRunAt: row.run_at, durationMs: row.duration_ms,
      counts: JSON.parse(row.counts_json), correlationId: row.correlation_id };
  });
}

const DETAIL_RETENTION_DAYS = 30;
const AGGREGATE_RETENTION_MONTHS = 12;

function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

// Rule: "30-day detailed + 12-month monthly aggregate" retention. Rolls
// every detail snapshot older than 30 days into a monthly (job_key,
// month_key) count before deleting it — only ever touches this module's
// OWN two tables, never a source-domain table (rule: "monitoring writes
// cannot affect source-domain state").
export function compactMonitoringHistory(now: Date = new Date()): { aggregated: number; purgedDetail: number; purgedAggregate: number } {
  const db = getDb();
  const detailCutoff = new Date(now.getTime() - DETAIL_RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
  const timestamp = now.toISOString();
  const stale = db.prepare(
    "select job_key, status, run_at from monitoring_job_snapshots where run_at<?",
  ).all(detailCutoff) as Array<{ job_key: string; status: MonitoringStatus; run_at: string }>;

  let aggregated = 0;
  const result = db.transaction(() => {
    for (const row of stale) {
      const key = monthKey(row.run_at);
      db.prepare(
        `insert into monitoring_job_monthly_aggregates (job_key,month_key,run_count,failed_count,created_at,updated_at)
         values (?,?,1,?,?,?)
         on conflict(job_key,month_key) do update set
           run_count=run_count+1, failed_count=failed_count+excluded.failed_count, updated_at=excluded.updated_at`,
      ).run(row.job_key, key, row.status === "failed" ? 1 : 0, timestamp, timestamp);
      aggregated += 1;
    }
    const purgedDetail = db.prepare("delete from monitoring_job_snapshots where run_at<?").run(detailCutoff).changes;

    const aggregateCutoff = monthKey(new Date(now.getTime() - AGGREGATE_RETENTION_MONTHS * 31 * 24 * 60 * 60_000).toISOString());
    const purgedAggregate = db.prepare("delete from monitoring_job_monthly_aggregates where month_key<?").run(aggregateCutoff).changes;
    return { purgedDetail, purgedAggregate };
  })();

  return { aggregated, purgedDetail: result.purgedDetail, purgedAggregate: result.purgedAggregate };
}

export function listMonthlyAggregates(jobKey: string): Array<{ month_key: string; run_count: number; failed_count: number }> {
  return getDb().prepare(
    "select month_key, run_count, failed_count from monitoring_job_monthly_aggregates where job_key=? order by month_key desc",
  ).all(jobKey) as Array<{ month_key: string; run_count: number; failed_count: number }>;
}
