import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getDb } from "@/lib/db/client";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { activateApp, createApp, editApp, softDeleteApp } from "@/lib/db/app-registry-repo";
import { applyDailyContribution } from "@/lib/db/analytics-contribution-repo";
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
  return activateApp(
    ADMIN, edited.id, { expectedVersion: edited.version, idempotencyKey: key(idemSuffix + 200) }, readyAdapter,
  );
}

describe("analytics admin read model", () => {
  it("resolves app identity for level/app aggregates and filters by date/app/ageBand (AT-AN-001-22)", async () => {
    const app = await activeApp();
    applyDailyContribution({
      activityDate: "2026-08-04", learnerId: "learner-1", appId: app.id, levelKey: "level-1",
      ageBand: "8_9", contributionId: "c-1",
      deltas: { engagedSeconds: 60, sessionsStarted: 1, sessionsCompleted: 0, sessionsInterrupted: 0, lessonsCompleted: 0 },
    });
    runDailyAggregation("2026-08-04", new Date("2026-08-05T00:15:00.000Z"));

    // Soft-delete the app after aggregation — the old aggregate row must
    // still resolve to a display name (business rule 27/AC22).
    const current = (await import("@/lib/db/app-registry-repo")).getApp(app.id)!;
    softDeleteApp(ADMIN, app.id, {
      expectedVersion: current.version, confirmationAppKey: app.appKey, reasonCode: "retired", idempotencyKey: key(900),
    });

    const levels = listDailyLevelAggregates({ from: "2026-08-04", to: "2026-08-04" });
    expect(levels).toHaveLength(1);
    expect(levels[0]).toMatchObject({ appKey: "chess-master", appDisplayName: "Chess Master", levelKey: "level-1", activeLearners: 1 });

    const apps = listDailyAppAggregates({ appId: app.id, ageBand: "8_9" });
    expect(apps).toHaveLength(1);
    expect(apps[0].appKey).toBe("chess-master");

    expect(listDailyAppAggregates({ ageBand: "10_12" })).toHaveLength(0);
    expect(listDailyLevelAggregates({ from: "2026-08-05" })).toHaveLength(0);
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
    runDailyAggregation("2026-08-03", new Date("2026-08-04T00:15:00.000Z"));
    runDailyAggregation("2026-08-04", new Date("2026-08-05T00:15:00.000Z"));

    const runs = listDailyRuns();
    expect(runs.map((r) => r.activityDate)).toEqual(["2026-08-04", "2026-08-03"]);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].controlTotals.engagedSeconds).toBe(30);
  });
});
