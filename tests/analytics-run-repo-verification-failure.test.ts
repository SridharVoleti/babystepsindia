import { beforeEach, describe, expect, it, vi } from "vitest";

// AT-AN-001-17: a control-total mismatch must fail the run, retain the
// buffer, and emit an admin alert. Real aggregation never disagrees with
// its own source, so the mismatch is injected by mocking the pure
// verification function this module depends on.
vi.mock("@/lib/analytics/aggregate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/aggregate")>();
  return {
    ...actual,
    verifyControlTotals: vi.fn(() => ({ ok: false, mismatches: ["engagedSeconds: injected mismatch"] })),
  };
});

import { useInMemoryDb } from "@/lib/db/test-utils";
import { getDb } from "@/lib/db/client";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { activateApp, createApp, editApp } from "@/lib/db/app-registry-repo";
import { applyDailyContribution, registerAnalyticsLevel } from "@/lib/db/analytics-contribution-repo";
import { runDailyAggregation } from "@/lib/db/analytics-run-repo";
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

async function activeApp() {
  const created = createApp(ADMIN, { appKey: "chess-master", displayName: "Chess Master", idempotencyKey: key(1) });
  const edited = editApp(ADMIN, created.id, {
    shortDescription: "Guided chess lessons and puzzles.",
    iconAssetKey: "icon-chess-piece",
    category: "learning",
    owningTeam: "platform",
    expectedVersion: created.version,
    idempotencyKey: key(2),
  });
  const activated = await activateApp(ADMIN, edited.id, { expectedVersion: edited.version, idempotencyKey: key(3) }, readyAdapter);
  registerAnalyticsLevel(activated.id, "level-1");
  return activated;
}

describe("runDailyAggregation — verification failure", () => {
  it("marks the run failed, retains the buffer, and emits an admin alert (AT-AN-001-17/24)", async () => {
    const app = await activeApp();
    applyDailyContribution({
      activityDate: "2026-08-04", learnerId: "learner-1", appId: app.id, levelKey: "level-1",
      ageBand: "8_9", contributionId: "c-1",
      deltas: { engagedSeconds: 60, sessionsStarted: 1, sessionsCompleted: 0, sessionsInterrupted: 0, lessonsCompleted: 0 },
    });

    const outcome = runDailyAggregation("2026-08-04", new Date("2026-08-05T00:15:00.000Z"));
    expect(outcome.status).toBe("failed");
    expect(outcome.failureCode).toBe("CONTROL_TOTAL_MISMATCH");

    const bufferRows = getDb().prepare("select * from analytics_daily_buffer where activity_date=?").all("2026-08-04");
    expect(bufferRows).toHaveLength(1);
    const levelRows = getDb().prepare("select * from analytics_daily_level where activity_date=?").all("2026-08-04");
    expect(levelRows).toHaveLength(0);

    const alerts = getDb().prepare("select * from platform_alerts where alert_type='analytics_run_failed'").all() as Record<string, unknown>[];
    expect(alerts).toHaveLength(1);
    expect(String(alerts[0].message)).toContain("2026-08-04");
    expect(String(alerts[0].metadata ?? "")).not.toContain("learner-1");
  });
});
