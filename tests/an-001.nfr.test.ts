import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getDb } from "@/lib/db/client";
import { applyDailyContribution, registerAnalyticsLevel } from "@/lib/db/analytics-contribution-repo";
import { runDailyAggregation } from "@/lib/db/analytics-run-repo";
import { ANALYTICS_NFR, monitorDailyAnalytics } from "@/lib/analytics/run-monitor";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const appId = "a1000000-0000-4000-8000-000000000099";

beforeEach(() => {
  useInMemoryDb();
  process.env.ANALYTICS_HMAC_SECRET = "nfr-test-analytics-secret-at-least-32-characters";
  getDb().prepare(
    `insert into app_registry(id,app_key,display_name,registry_status)
     values(?, 'nfr-app', 'NFR App', 'active')`,
  ).run(appId);
  registerAnalyticsLevel(appId, "level-1");
  registerAnalyticsLevel(appId, "level-2");
});

function contribute(index: number, levelKey = "level-1") {
  applyDailyContribution({
    activityDate: "2026-08-05",
    learnerId: `learner-${index}`,
    appId,
    levelKey,
    ageBand: index % 2 ? "8_9" : "10_12",
    contributionId: `nfr-contribution-${index}-${levelKey}`,
    deltas: { engagedSeconds: 30, sessionsStarted: 1, sessionsCompleted: index % 2,
      sessionsInterrupted: (index + 1) % 2, lessonsCompleted: index % 3 === 0 ? 1 : 0 },
  });
}

describe("AN-001 non-functional and operational requirements", () => {
  it("keeps synchronous buffer-update p95 below 500 ms", () => {
    const samples: number[] = [];
    for (let index = 0; index < 60; index += 1) {
      const started = performance.now();
      contribute(index);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    expect(p95).toBeLessThan(ANALYTICS_NFR.bufferUpdateP95Ms);
  });

  it("completes a representative V1 daily run inside 30 minutes and restarts safely", () => {
    for (let index = 0; index < 500; index += 1) contribute(index, index % 3 === 0 ? "level-2" : "level-1");
    const started = performance.now();
    const first = runDailyAggregation("2026-08-05", new Date("2026-08-05T18:45:00.000Z"));
    const elapsed = performance.now() - started;
    const rowsBefore = getDb().prepare("select * from analytics_daily_app order by age_band").all();
    const second = runDailyAggregation("2026-08-05", new Date("2026-08-05T18:46:00.000Z"));

    expect(first.status).toBe("completed");
    expect(elapsed).toBeLessThan(ANALYTICS_NFR.dailyRunMaxMs);
    expect(second).toEqual(first);
    expect(getDb().prepare("select * from analytics_daily_app order by age_band").all()).toEqual(rowsBefore);
  });

  it("declares a single-date lock, control verification, and post-success purge order", () => {
    const source = read("src/lib/db/analytics-run-repo.ts");
    expect(source).toMatch(/claimDailyRun[\s\S]*verifyControlTotals[\s\S]*commitAggregates[\s\S]*purgeDailyBuffer/);
    expect(read("src/lib/db/schema.sql")).toMatch(/analytics_daily_runs \([\s\S]*activity_date text primary key/);
  });

  it("leaves zero source rows after success and keeps exact control totals", () => {
    for (let index = 0; index < 20; index += 1) contribute(index);
    const outcome = runDailyAggregation("2026-08-05", new Date("2026-08-05T18:45:00.000Z"));
    expect(outcome).toMatchObject({ status: "completed", sourceRowCount: 20,
      controlTotals: { engagedSeconds: 600, sessionsStarted: 20 } });
    expect(getDb().prepare("select count(*) count from analytics_daily_buffer").get()).toEqual({ count: 0 });
    expect(getDb().prepare("select count(*) count from analytics_contribution_receipts").get()).toEqual({ count: 0 });
  });

  it("has no raw-event growth path and supports every required cohort filter", () => {
    const schema = read("src/lib/db/schema.sql");
    expect(schema).not.toMatch(/create table if not exists analytics_(?:event|click|page|heartbeat|session_history)/);
    const admin = read("src/lib/db/analytics-admin-repo.ts");
    for (const filter of ["from", "to", "appId", "levelKey", "ageBand"]) expect(admin).toContain(`filters.${filter}`);
  });

  it("uses UTC instants internally and explicit Asia/Kolkata activity-date derivation", () => {
    const gateway = read("src/lib/learning-session/gateway.ts");
    const finalization = read("src/lib/session-finalization/service.ts");
    expect(gateway).toContain("toISOString()");
    expect(gateway).toContain("kolkataCalendarDate(now)");
    expect(finalization).toContain("now.toISOString()");
    expect(finalization).toContain("kolkataCalendarDate(now)");
    expect(read("scripts/run-an001-daily.mjs")).toContain('const KOLKATA_TIME_ZONE = "Asia/Kolkata"');
  });

  it("caps the scheduled job below 30 minutes and runs an independent 00:50 monitor", () => {
    const workflow = read(".github/workflows/an001-daily-analytics.yml");
    expect(workflow).toContain("timeout-minutes: 10");
    expect(workflow).toContain("cron: '20 19 * * *'");
    expect(workflow).toContain("run: node scripts/run-an001-daily.mjs --monitor");
  });

  it("documents a reversible down path for every AN-001 migration without source restoration", () => {
    const migrations = [
      "0015_an001_analytics.sql", "0028_an001_midnight_engaged_split.sql",
      "0029_an001_atomic_daily_run_claim.sql", "0030_an001_analytics_service_principals.sql",
      "0033_an001_app_analytics_levels.sql", "0035_an001_analytics_admin_read_permission.sql",
    ].map((file) => read(`supabase/migrations/${file}`));
    for (const migration of migrations) expect(migration).toMatch(/Down migration \(apply manually/);
    expect(migrations.join("\n")).not.toMatch(/insert into analytics_daily_buffer|restore.*pseudonym/i);
  });
});

describe("AN-001 missed, failed, and overdue monitoring", () => {
  const monitorAt = new Date("2026-08-05T19:20:00.000Z"); // 00:50 IST on Aug 6; monitors Aug 5.

  it("does not alert before the independent monitor window", () => {
    expect(monitorDailyAnalytics(new Date("2026-08-05T19:14:00.000Z")))
      .toEqual({ activityDate: "2026-08-05", state: "too_early", alertCreated: false });
    expect(getDb().prepare("select * from platform_alerts").all()).toHaveLength(0);
  });

  it("alerts once when the expected run is missing", () => {
    expect(monitorDailyAnalytics(monitorAt)).toMatchObject({ activityDate: "2026-08-05", state: "missed", alertCreated: true });
    expect(monitorDailyAnalytics(monitorAt)).toMatchObject({ state: "missed", alertCreated: false });
    const alerts = getDb().prepare("select alert_type,metadata from platform_alerts").all() as Array<Record<string, unknown>>;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alert_type).toBe("analytics_run_missed");
    expect(String(alerts[0].metadata)).not.toMatch(/learner|parent|session/i);
  });

  it("alerts failed runs idempotently", () => {
    getDb().prepare(`insert into analytics_daily_runs(activity_date,status,run_version,started_at,completed_at,failure_code)
      values('2026-08-05','failed',1,'2026-08-05T18:45:00.000Z','2026-08-05T18:46:00.000Z','TEST_FAILURE')`).run();
    expect(monitorDailyAnalytics(monitorAt)).toMatchObject({ state: "failed", alertCreated: true });
    expect(monitorDailyAnalytics(monitorAt)).toMatchObject({ state: "failed", alertCreated: false });
  });

  it("alerts running or late-completed runs that exceed 30 minutes", () => {
    getDb().prepare(`insert into analytics_daily_runs(activity_date,status,run_version,started_at)
      values('2026-08-05','running',1,'2026-08-05T18:45:00.000Z')`).run();
    expect(monitorDailyAnalytics(monitorAt)).toMatchObject({ state: "overdue", alertCreated: true });
    getDb().prepare(`update analytics_daily_runs set status='completed',completed_at='2026-08-05T19:16:00.000Z'
      where activity_date='2026-08-05'`).run();
    expect(monitorDailyAnalytics(monitorAt)).toMatchObject({ state: "overdue", alertCreated: false });
  });

  it("reports a within-budget completed run as healthy", () => {
    getDb().prepare(`insert into analytics_daily_runs(activity_date,status,run_version,started_at,completed_at)
      values('2026-08-05','completed',1,'2026-08-05T18:45:00.000Z','2026-08-05T19:14:59.000Z')`).run();
    expect(monitorDailyAnalytics(monitorAt)).toEqual({ activityDate: "2026-08-05", state: "healthy", alertCreated: false });
  });
});
