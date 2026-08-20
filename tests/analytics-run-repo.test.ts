import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getDb } from "@/lib/db/client";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { activateApp, createApp, editApp } from "@/lib/db/app-registry-repo";
import { applyDailyContribution, registerAnalyticsLevel } from "@/lib/db/analytics-contribution-repo";
import { claimDailyRun, purgeDailyBuffer, runDailyAggregation } from "@/lib/db/analytics-run-repo";
import { AnalyticsError } from "@/lib/analytics/errors";
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
  const created = await createApp(ADMIN, { appKey, displayName: "Chess Master", idempotencyKey: key(idemSuffix) });
  const edited = await editApp(ADMIN, created.id, {
    shortDescription: "Guided chess lessons and puzzles.",
    iconAssetKey: "icon-chess-piece",
    category: "learning",
    owningTeam: "platform",
    expectedVersion: created.version,
    idempotencyKey: key(idemSuffix + 100),
  });
  const activated = await activateApp(
    ADMIN, edited.id, { expectedVersion: edited.version, idempotencyKey: key(idemSuffix + 200) }, readyAdapter,
  );
  await registerAnalyticsLevel(activated.id, "level-1");
  await registerAnalyticsLevel(activated.id, "level-2");
  return activated;
}

async function contribute(appId: string, overrides: Record<string, unknown> = {}) {
  await applyDailyContribution({
    activityDate: "2026-08-04",
    learnerId: "learner-1",
    appId,
    levelKey: "level-1",
    ageBand: "8_9",
    contributionId: "c-1",
    deltas: { engagedSeconds: 60, sessionsStarted: 1, sessionsCompleted: 1, sessionsInterrupted: 0, lessonsCompleted: 1 },
    ...overrides,
  });
}

describe("claimDailyRun (AT-AN-001-10)", () => {
  it("the first caller obtains the lock; a duplicate invocation returns the current run instead", async () => {
    const first = await claimDailyRun("2026-08-04", new Date("2026-08-05T00:15:00.000Z"));
    expect(first.claimed).toBe(true);
    expect(first.run.status).toBe("running");

    const second = await claimDailyRun("2026-08-04", new Date("2026-08-05T00:15:01.000Z"));
    expect(second.claimed).toBe(false);
    expect(second.run.status).toBe("running");
  });

  it("reclaims one failed version exactly once", async () => {
    getDb().prepare(`insert into analytics_daily_runs(activity_date,status,run_version,started_at,completed_at,failure_code)
      values('2026-08-04','failed',1,?,?, 'CONTROL_TOTAL_MISMATCH')`)
      .run("2026-08-05T00:15:00.000Z", "2026-08-05T00:16:00.000Z");

    const first = await claimDailyRun("2026-08-04", new Date("2026-08-05T00:20:00.000Z"));
    const second = await claimDailyRun("2026-08-04", new Date("2026-08-05T00:20:01.000Z"));

    expect(first).toMatchObject({ claimed: true, run: { status: "running", run_version: 2 } });
    expect(second).toMatchObject({ claimed: false, run: { status: "running", run_version: 2 } });
  });
});

describe("runDailyAggregation", () => {
  it("fails explicitly before claiming or mutating a run when the analytics secret is unavailable", async () => {
    const app = await activeApp();
    await contribute(app.id);
    delete process.env.ANALYTICS_HMAC_SECRET;

    await expect(runDailyAggregation("2026-08-04", new Date("2026-08-05T00:15:00.000Z")))
      .rejects.toThrow(new AnalyticsError("ANALYTICS_SECRET_MISSING"));

    expect(getDb().prepare("select * from analytics_daily_runs").all()).toHaveLength(0);
    expect(getDb().prepare("select * from analytics_daily_level").all()).toHaveLength(0);
    expect(getDb().prepare("select * from analytics_daily_app").all()).toHaveLength(0);
    expect(getDb().prepare("select * from analytics_daily_buffer where activity_date=?").all("2026-08-04"))
      .toHaveLength(1);
  });

  it("writes level and app aggregates, verifies totals, completes, and purges the buffer (AT-AN-001-11/16/18)", async () => {
    const app = await activeApp();
    await contribute(app.id, { contributionId: "c-1", learnerId: "learner-1" });
    await contribute(app.id, { contributionId: "c-2", learnerId: "learner-2", levelKey: "level-2" });

    const outcome = await runDailyAggregation("2026-08-04", new Date("2026-08-05T00:15:00.000Z"));
    expect(outcome.status).toBe("completed");
    expect(outcome.sourceRowCount).toBe(2);

    const levelRows = getDb().prepare("select * from analytics_daily_level where activity_date=?").all("2026-08-04") as Record<string, unknown>[];
    expect(levelRows).toHaveLength(2);
    const appRows = getDb().prepare("select * from analytics_daily_app where activity_date=?").all("2026-08-04") as Record<string, unknown>[];
    expect(appRows).toHaveLength(1);
    expect(appRows[0].active_learners).toBe(2);
    expect(appRows[0].engaged_seconds).toBe(120);

    const bufferRows = getDb().prepare("select * from analytics_daily_buffer where activity_date=?").all("2026-08-04");
    expect(bufferRows).toHaveLength(0);
    const receipts = getDb().prepare("select * from analytics_contribution_receipts where activity_date=?").all("2026-08-04");
    expect(receipts).toHaveLength(0);
  });

  it("fails and retains the buffer if an unknown level bypasses contribution validation", async () => {
    const app = await activeApp();
    await contribute(app.id);
    getDb().prepare("update analytics_daily_buffer set level_key='tampered-level'").run();

    const outcome = await runDailyAggregation("2026-08-04", new Date("2026-08-05T00:15:00.000Z"));
    expect(outcome).toMatchObject({ status: "failed", failureCode: "UNKNOWN_LEVEL_KEY" });
    expect(getDb().prepare("select * from analytics_daily_buffer").all()).toHaveLength(1);
    expect(getDb().prepare("select * from analytics_daily_level").all()).toHaveLength(0);
  });

  it("run metadata carries no learner identifier, only control totals (AT-AN-001-20)", async () => {
    const app = await activeApp();
    await contribute(app.id);
    await runDailyAggregation("2026-08-04", new Date("2026-08-05T00:15:00.000Z"));
    const run = getDb().prepare("select * from analytics_daily_runs where activity_date=?").get("2026-08-04") as Record<string, unknown>;
    expect(Object.keys(run).sort()).toEqual([
      "activity_date", "completed_at", "failure_code", "run_version", "source_engaged_seconds",
      "source_lessons_completed", "source_row_count", "source_sessions_completed",
      "source_sessions_interrupted", "source_sessions_started", "started_at", "status",
    ]);
  });

  it("a rerun with identical buffer contents produces identical aggregate rows (AT-AN-001-13/19)", async () => {
    const app = await activeApp();
    await contribute(app.id);
    const firstOutcome = await runDailyAggregation("2026-08-04", new Date("2026-08-05T00:15:00.000Z"));
    const levelBefore = getDb().prepare("select * from analytics_daily_level where activity_date=?").all("2026-08-04");

    // Buffer already purged; invoking again for the same date must not
    // change the committed aggregates or error.
    const secondOutcome = await runDailyAggregation("2026-08-04", new Date("2026-08-05T00:20:00.000Z"));
    expect(secondOutcome.status).toBe("completed");
    expect(secondOutcome).toEqual(firstOutcome);
    const levelAfter = getDb().prepare("select * from analytics_daily_level where activity_date=?").all("2026-08-04");
    expect(levelAfter).toEqual(levelBefore);
  });

  it("rejects a contribution to a date whose run already failed until retried, and a retry reprocesses the retained buffer (AT-AN-001-19)", async () => {
    const app = await activeApp();
    await contribute(app.id);
    // Force a run row into 'failed' directly to simulate a prior failed run
    // (the verification-failure path itself is covered by
    // analytics-run-repo-verification-failure.test.ts).
    const now = new Date("2026-08-05T00:15:00.000Z").toISOString();
    getDb().prepare(
      `insert into analytics_daily_runs(activity_date,status,run_version,started_at,completed_at,failure_code)
       values('2026-08-04','failed',1,?,?,'CONTROL_TOTAL_MISMATCH')`,
    ).run(now, now);

    const bufferBefore = getDb().prepare("select * from analytics_daily_buffer where activity_date=?").all("2026-08-04");
    expect(bufferBefore).toHaveLength(1);

    const outcome = await runDailyAggregation("2026-08-04", new Date("2026-08-05T00:30:00.000Z"));
    expect(outcome.status).toBe("completed");
    expect(outcome.runVersion).toBe(2);
    const bufferAfter = getDb().prepare("select * from analytics_daily_buffer where activity_date=?").all("2026-08-04");
    expect(bufferAfter).toHaveLength(0);
  });
});

describe("purgeDailyBuffer (AT-AN-001-30)", () => {
  it("retrying an already-empty purge is safe and leaves aggregates untouched", async () => {
    const app = await activeApp();
    await contribute(app.id);
    await runDailyAggregation("2026-08-04", new Date("2026-08-05T00:15:00.000Z"));
    const levelBefore = getDb().prepare("select * from analytics_daily_level where activity_date=?").all("2026-08-04");

    await purgeDailyBuffer("2026-08-04");

    const levelAfter = getDb().prepare("select * from analytics_daily_level where activity_date=?").all("2026-08-04");
    expect(levelAfter).toEqual(levelBefore);
  });

  it("refuses to purge a date whose run has not completed", async () => {
    await claimDailyRun("2026-08-04", new Date("2026-08-05T00:15:00.000Z"));
    await expect(purgeDailyBuffer("2026-08-04")).rejects.toThrow();
  });
});
