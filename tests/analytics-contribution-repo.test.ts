import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getDb } from "@/lib/db/client";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { activateApp, createApp, editApp, softDeleteApp } from "@/lib/db/app-registry-repo";
import { AnalyticsError } from "@/lib/analytics/errors";
import { learnerDailyKey } from "@/lib/analytics/daily-key";
import { applyDailyContribution } from "@/lib/db/analytics-contribution-repo";
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
  return activated;
}

function contribution(overrides: Record<string, unknown> = {}) {
  return {
    activityDate: "2026-08-04",
    learnerId: "learner-1",
    appId: "app-placeholder",
    levelKey: "level-1",
    ageBand: "8_9" as const,
    contributionId: "contribution-1",
    deltas: { engagedSeconds: 60, sessionsStarted: 1, sessionsCompleted: 0, sessionsInterrupted: 0, lessonsCompleted: 0 },
    ...overrides,
  };
}

describe("applyDailyContribution", () => {
  it("creates one buffer row keyed by date/daily-key/app/level (AT-AN-001-03)", async () => {
    const app = await activeApp();
    applyDailyContribution(contribution({ appId: app.id }));
    const rows = getDb().prepare("select * from analytics_daily_buffer").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].engaged_seconds).toBe(60);
    expect(rows[0].sessions_started).toBe(1);
  });

  it("combines multiple contributions for the same grain into one row (AT-AN-001-03)", async () => {
    const app = await activeApp();
    applyDailyContribution(contribution({ appId: app.id, contributionId: "c-1", deltas: { engagedSeconds: 30, sessionsStarted: 1, sessionsCompleted: 0, sessionsInterrupted: 0, lessonsCompleted: 0 } }));
    applyDailyContribution(contribution({ appId: app.id, contributionId: "c-2", deltas: { engagedSeconds: 45, sessionsStarted: 0, sessionsCompleted: 1, sessionsInterrupted: 0, lessonsCompleted: 0 } }));
    const rows = getDb().prepare("select * from analytics_daily_buffer").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].engaged_seconds).toBe(75);
    expect(rows[0].sessions_started).toBe(1);
    expect(rows[0].sessions_completed).toBe(1);
  });

  it("never writes the raw learner id — only the date-specific HMAC key (AT-AN-001-04/05)", async () => {
    const app = await activeApp();
    applyDailyContribution(contribution({ appId: app.id, learnerId: "learner-secret" }));
    const row = getDb().prepare("select * from analytics_daily_buffer").get() as Record<string, unknown>;
    expect(Object.values(row).some((v) => typeof v === "string" && v.includes("learner-secret"))).toBe(false);
    expect(row.learner_daily_key).toBe(learnerDailyKey("learner-secret", "2026-08-04"));
  });

  it("retrying the same contributionId does not double count (AT-AN-001-08)", async () => {
    const app = await activeApp();
    const payload = contribution({ appId: app.id, contributionId: "retry-me" });
    const first = applyDailyContribution(payload);
    const second = applyDailyContribution(payload);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    const row = getDb().prepare("select * from analytics_daily_buffer").get() as Record<string, unknown>;
    expect(row.engaged_seconds).toBe(60);
    expect(row.sessions_started).toBe(1);
  });

  it("rejects a contribution for a soft-deleted app (AT-AN-001-21)", async () => {
    const app = await activeApp();
    softDeleteApp(ADMIN, app.id, {
      expectedVersion: app.version, confirmationAppKey: app.appKey, reasonCode: "retired", idempotencyKey: key(900),
    });
    expect(() => applyDailyContribution(contribution({ appId: app.id })))
      .toThrow(new AnalyticsError("APP_NOT_ACTIVE"));
    const rows = getDb().prepare("select * from analytics_daily_buffer").all();
    expect(rows).toHaveLength(0);
  });

  it("rejects a contribution for an unknown app", () => {
    expect(() => applyDailyContribution(contribution({ appId: "does-not-exist" })))
      .toThrow(new AnalyticsError("APP_NOT_FOUND"));
  });

  it("fails closed with no buffer row when the analytics secret is missing (AT-AN-001-29)", async () => {
    const app = await activeApp();
    delete process.env.ANALYTICS_HMAC_SECRET;
    expect(() => applyDailyContribution(contribution({ appId: app.id })))
      .toThrow(new AnalyticsError("ANALYTICS_SECRET_MISSING"));
    const rows = getDb().prepare("select * from analytics_daily_buffer").all();
    expect(rows).toHaveLength(0);
    const receipts = getDb().prepare("select * from analytics_contribution_receipts").all();
    expect(receipts).toHaveLength(0);
  });
});
