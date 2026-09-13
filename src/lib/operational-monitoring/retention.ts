import { db } from "@/lib/db/client";

// AN-002 retention: detailed operational evidence is kept for 30 days;
// monthly anonymous operational aggregates are kept for 12 months.
export function compactOperationalMonitoring(now = new Date()) {
  const detailCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const monthlyCutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1))
    .toISOString().slice(0, 10);

  return db.transaction(() => {
    db.prepare(`
      insert into operational_monitoring_monthly(
        month_start,operation_key,run_count,success_count,failure_count,
        processed_count,retry_count,total_duration_ms,last_run_at,generated_at
      )
      select
        date(started_at,'start of month'), operation_key, count(*),
        sum(case when status='succeeded' then 1 else 0 end),
        sum(case when status='failed' then 1 else 0 end),
        sum(processed_count), sum(retry_count), sum(duration_ms), max(started_at), datetime('now')
      from operational_monitoring_runs
      where created_at < ?
      group by date(started_at,'start of month'), operation_key
      on conflict(month_start,operation_key) do update set
        run_count=excluded.run_count,
        success_count=excluded.success_count,
        failure_count=excluded.failure_count,
        processed_count=excluded.processed_count,
        retry_count=excluded.retry_count,
        total_duration_ms=excluded.total_duration_ms,
        last_run_at=excluded.last_run_at,
        generated_at=excluded.generated_at
    `).run(detailCutoff);

    const purgedDetail = db.prepare(
      "delete from operational_monitoring_runs where created_at < ?",
    ).run(detailCutoff).changes;
    const purgedMonthly = db.prepare(
      "delete from operational_monitoring_monthly where month_start < ?",
    ).run(monthlyCutoff).changes;

    return { purgedDetail, purgedMonthly };
  }).immediate();
}
