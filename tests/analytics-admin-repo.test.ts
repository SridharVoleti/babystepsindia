import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getDb } from "@/lib/db/client";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { activateApp, createApp, editApp, softDeleteApp } from "@/lib/db/app-registry-repo";
import { applyDailyContribution, registerAnalyticsLevel } from "@/lib/db/analytics-contribution-repo";
import { runDailyAggregation } from "@/lib/db/analytics-run-repo";
import { listDailyAppAggregates, listDailyLevelAggregates, listDailyRuns } from "@/lib/db/analytics-admin-repo";
import type { EnvironmentReadinessAdapter } from "@/lib/app-registry/readiness-adapter";

let ADMIN: string;

beforeEach(async () => {
  useInMemoryDb();
  process.env.ANALYTICS_HMAC_SECRET = "test-only-analytics-secret-32-bytes-min";
  ADMIN = (await sqliteAuthAdapter.signUp("admin-actor@example.com", "CorrectHorse1!")).user.id;
});

function key(n: number) {
  return `${"1".repeat(8)}-1111-4111-8111-${String(n).padStart(12, "0")}`;
}

const readyAdapter: EnvironmentReadinessAdapter = { checkReady: async () => ({ ready: true }) };

async function activeApp(idemSuffix = 1, appKey = "chess-master") {
  const created = createApp(ADMIN, { appKey, displayName: "Chess Master", idempotencyKey: key(idemSuffix) });
  const edited = editApp(ADMIN, created.id, {
    shortDescription: "desc", iconAssetKey: "icon-chess-piece", category: "learning", owningTeam: "platform",
    expectedVersion: created.version, idempotencyKey: key(idemSuffix + 100),
  });
  const activated = await activateApp(
    ADMIN, edited.id, { expectedVersion: edited.version, idempotencyKey: key(idemSuffix + 200) }, readyAdapter,
  );
  registerAnalyticsLevel(activated.id, "level-1");
  return activated;
}

describe("analytics admin read model", () => {
  it("resolves app identity for level/app aggregates and filters by date/app/ageBand (AT-AN-001-22)", async () => {
    const app = await activeApp();
    applyDailyContribution({
      activityDate: "2026-08-04", learnerId: "learner-1", appId: app.id, levelKey: "level-1",
      ageBand: "8_9", contributionId: "c-1",
      deltas: { engagedSeconds: 60, sessionsStarted: 1, sessionsCompleted: 0, sessionsInterrupted: 0, lessonsCompleted: 0 },
    });
    await runDailyAggregation("2026-08-04", new Date("2026-08-05T00:15:00.000Z"));

    // Soft-delete the app after aggregation — the old aggregate row must
    // still resolve to a display name (business rule 27/AC22).
    const current = (await import("@/lib/db/app-registry-repo")).getApp(app.id)!;
    softDeleteApp(ADMIN, app.id, {
      expectedVersion: current.version, confirmationAppKey: app.appKey, reasonCode: "retired", idempotencyKey: key(900),
    });

    const levels = await listDailyLevelAggregates({ from: "2026-08-04", to: "2026-08-04" });
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ appKey: "chess-master", appDisplayName: "Chess Master", levelKey: "level-1", activeLearners: 1 });

    const apps = await listDailyAppAggregates({ appId: app.id, ageBand: "8_9" });
    expect(apps).toHaveLength(1);
    expect(apps[0].appKey).toBe("chess-master");

    expect(await listDailyAppAggregates({ ageBand: "10_12" })).toHaveLength(0);
    expect(await listDailyLevelAggregates({ from: "2026-08-05" })).toHaveLength(0);
  });

  it("lists runs newest first with status/control totals only (AT-AN-001-20/32)", async () => {
    const app = await activeApp();
    applyDailyContribution({
      activityDate: "2026-08-03", learnerId: "learner-1", appId: app.id, levelKey: "level-1",
      ageBand: "8_9", contributionId: "c-1",
      deltas: { engagedSeconds: 30, sessionsStarted: 1, sessionsCompleted: 0, sessionsInterrupted: 0, lessonsCompleted: 0 },
    });
    applyDailyContribution({
      activityDate: "2026-08-04", learnerId: "learner-1", appId: app.id, levelKey: "level-1",
      ageBand: "8_9", contributionId: "c-2",
      deltas: { engagedSeconds: 30, sessionsStarted: 1, sessionsCompleted: 0, sessionsInterrupted: 0, lessonsCompleted: 0 },
    });
    await runDailyAggregation("2026-08-03", new Date("2026-08-04T00:15:00.000Z"));
    await runDailyAggregation("2026-08-04", new Date("2026-08-05T00:15:00.000Z"));

    const runs = await listDailyRuns();
    expect(runs.map((r) => r.activityDate)).toEqual(["2026-08-04", "2026-08-03"]);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].controlTotals.engagedSeconds).toBe(30);
  });

  it("returns aggregates only for dates whose matching run is completed", async () => {
    const app = await activeApp();
    applyDailyContribution({
      activityDate: "2026-08-01", learnerId: "learner-1", appId: app.id, levelKey: "level-1",
      ageBand: "8_9", contributionId: "completed-source",
      deltas: { engagedSeconds: 30, sessionsStarted: 1, sessionsCompleted: 0,
        sessionsInterrupted: 0, lessonsCompleted: 0 },
    });
    await runDailyAggregation("2026-08-01", new Date("2026-08-02T00:15:00.000Z"));

    // Simulate stale/partially committed rows. Admin reads must use run status
    // as the publication boundary, not trust aggregate-table presence alone.
    for (const date of ["2026-08-02", "2026-08-03", "2026-08-04"]) {
      getDb().prepare(`insert into analytics_daily_level
        select ?,app_id,level_key,age_band,active_learners,sessions_started,sessions_completed,
          sessions_interrupted,engaged_seconds,lessons_completed,generated_at,run_version
        from analytics_daily_level where activity_date='2026-08-01'`).run(date);
      getDb().prepare(`insert into analytics_daily_app
        select ?,app_id,age_band,active_learners,sessions_started,sessions_completed,
          sessions_interrupted,engaged_seconds,lessons_completed,generated_at,run_version
        from analytics_daily_app where activity_date='2026-08-01'`).run(date);
    }
    getDb().prepare(`insert into analytics_daily_runs(activity_date,status,run_version,started_at)
      values('2026-08-02','running',1,'2026-08-03T00:15:00.000Z')`).run();
    getDb().prepare(`insert into analytics_daily_runs(activity_date,status,run_version,started_at,completed_at,failure_code)
      values('2026-08-03','failed',1,'2026-08-04T00:15:00.000Z','2026-08-04T00:16:00.000Z','TEST')`).run();
    // 2026-08-04 intentionally has no run record.

    expect((await listDailyLevelAggregates({})).map((row) => row.activityDate)).toEqual(["2026-08-01"]);
    expect((await listDailyAppAggregates({})).map((row) => row.activityDate)).toEqual(["2026-08-01"]);
  });
});
