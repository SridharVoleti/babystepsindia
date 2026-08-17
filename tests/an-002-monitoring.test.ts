// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import {
  compactMonitoringHistory, getOperationalStatus, listMonthlyAggregates, syncMonitoringSnapshots,
} from "@/lib/monitoring/service";

beforeEach(() => {
  useInMemoryDb();
});

function seedBillingJobRun(status: "completed" | "failed" | "running", createdAt: string, completedAt: string | null) {
  getDb().prepare(
    `insert into billing_job_runs (principal_id,job_type,run_idempotency_key,request_hash,status,created_at,completed_at)
     values (?,?,?,?,?,?,?)`,
  ).run("svc-1", "reconcile", randomUUID(), "hash", status, createdAt, completedAt);
}

function seedProgressIntegritySweepRun(createdAt: string) {
  getDb().prepare(
    `insert into progress_integrity_sweep_runs
     (run_idempotency_key,cursor,environment,app_id,processed,next_cursor,incidents_opened,repairs_applied,created_at)
     values (?,?,?,?,?,?,?,?,?)`,
  ).run(randomUUID(), "", "production", null, 10, null, 1, 1, createdAt);
}

describe("AN-002 syncMonitoringSnapshots / getOperationalStatus", () => {
  it("AC1: exposes last run/status for a critical job from its own source table", () => {
    seedBillingJobRun("completed", "2026-08-10T00:00:00.000Z", "2026-08-10T00:01:00.000Z");
    syncMonitoringSnapshots(new Date("2026-08-10T00:02:00.000Z"));
    const status = getOperationalStatus().find((j) => j.jobKey === "billing_reconcile");
    expect(status?.status).toBe("completed");
    expect(status?.lastRunAt).toBe("2026-08-10T00:00:00.000Z");
    expect(status?.durationMs).toBe(60_000);
  });

  it("AC2: dependency failures are distinguishable from successes", () => {
    seedBillingJobRun("failed", "2026-08-10T00:00:00.000Z", "2026-08-10T00:01:00.000Z");
    syncMonitoringSnapshots(new Date("2026-08-10T00:02:00.000Z"));
    expect(getOperationalStatus().find((j) => j.jobKey === "billing_reconcile")?.status).toBe("failed");
  });

  it("a job with no runs yet reports 'unknown', never a fabricated status", () => {
    expect(getOperationalStatus().find((j) => j.jobKey === "billing_renewal_reminder")?.status).toBe("unknown");
  });

  it("AC4/rule: syncing never mutates the source table it reads from", () => {
    seedBillingJobRun("completed", "2026-08-10T00:00:00.000Z", "2026-08-10T00:01:00.000Z");
    const before = getDb().prepare("select status, completed_at from billing_job_runs").get();
    syncMonitoringSnapshots(new Date("2026-08-10T00:02:00.000Z"));
    expect(getDb().prepare("select status, completed_at from billing_job_runs").get()).toEqual(before);
  });

  it("is idempotent — re-syncing the same source rows never duplicates a snapshot", () => {
    seedBillingJobRun("completed", "2026-08-10T00:00:00.000Z", "2026-08-10T00:01:00.000Z");
    syncMonitoringSnapshots(new Date("2026-08-10T00:02:00.000Z"));
    syncMonitoringSnapshots(new Date("2026-08-10T00:03:00.000Z"));
    const count = getDb().prepare("select count(*) n from monitoring_job_snapshots where job_key='billing_reconcile'").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("carries safe, non-payload counts through for the progress-integrity sweep source", () => {
    seedProgressIntegritySweepRun("2026-08-10T00:00:00.000Z");
    syncMonitoringSnapshots(new Date("2026-08-10T00:02:00.000Z"));
    const status = getOperationalStatus().find((j) => j.jobKey === "progress_integrity_sweep");
    expect(status?.counts).toMatchObject({ processed: 10, incidentsOpened: 1, repairsApplied: 1 });
  });
});

describe("AN-002 compactMonitoringHistory (AC3: 30-day detail + 12-month aggregate retention)", () => {
  it("rolls a detail snapshot older than 30 days into a monthly aggregate, then purges the detail row", () => {
    const old = new Date("2026-06-01T00:00:00.000Z");
    seedBillingJobRun("completed", old.toISOString(), old.toISOString());
    syncMonitoringSnapshots(old);
    const now = new Date("2026-08-15T00:00:00.000Z");
    const result = compactMonitoringHistory(now);
    expect(result.aggregated).toBe(1);
    expect(result.purgedDetail).toBe(1);
    const remaining = getDb().prepare("select count(*) n from monitoring_job_snapshots").get() as { n: number };
    expect(remaining.n).toBe(0);
    const aggregates = listMonthlyAggregates("billing_reconcile");
    expect(aggregates).toContainEqual(expect.objectContaining({ month_key: "2026-06", run_count: 1, failed_count: 0 }));
  });

  it("keeps a detail snapshot within the last 30 days untouched", () => {
    const recent = new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString();
    seedBillingJobRun("completed", recent, recent);
    syncMonitoringSnapshots(new Date(recent));
    compactMonitoringHistory(new Date());
    const remaining = getDb().prepare("select count(*) n from monitoring_job_snapshots").get() as { n: number };
    expect(remaining.n).toBe(1);
  });

  it("never touches the source job-run table during compaction either", () => {
    const old = new Date("2026-06-01T00:00:00.000Z");
    seedBillingJobRun("completed", old.toISOString(), old.toISOString());
    syncMonitoringSnapshots(old);
    const before = getDb().prepare("select count(*) n from billing_job_runs").get();
    compactMonitoringHistory(new Date("2026-08-15T00:00:00.000Z"));
    expect(getDb().prepare("select count(*) n from billing_job_runs").get()).toEqual(before);
  });

  it("purges a monthly aggregate older than 12 months", () => {
    getDb().prepare(
      `insert into monitoring_job_monthly_aggregates (job_key,month_key,run_count,failed_count,created_at,updated_at)
       values ('billing_reconcile','2024-01',5,1,?,?)`,
    ).run(new Date().toISOString(), new Date().toISOString());
    compactMonitoringHistory(new Date("2026-08-15T00:00:00.000Z"));
    expect(listMonthlyAggregates("billing_reconcile")).toEqual([]);
  });
});
