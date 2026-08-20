import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getDb } from "@/lib/db/client";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { activateApp, createApp, editApp, softDeleteApp } from "@/lib/db/app-registry-repo";
import { AnalyticsError } from "@/lib/analytics/errors";
import { learnerDailyKey } from "@/lib/analytics/daily-key";
import { applyDailyContribution, applyTrustedCounterEvent, registerAnalyticsLevel } from "@/lib/db/analytics-contribution-repo";
import { createLearner } from "@/lib/db/learner-repo";
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
  await registerAnalyticsLevel(activated.id, "level-7");
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
    await applyDailyContribution(contribution({ appId: app.id }));
    const rows = getDb().prepare("select * from analytics_daily_buffer").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].engaged_seconds).toBe(60);
    expect(rows[0].sessions_started).toBe(1);
  });

  it("combines multiple contributions for the same grain into one row (AT-AN-001-03)", async () => {
    const app = await activeApp();
    await applyDailyContribution(contribution({ appId: app.id, contributionId: "c-1", deltas: { engagedSeconds: 30, sessionsStarted: 1, sessionsCompleted: 0, sessionsInterrupted: 0, lessonsCompleted: 0 } }));
    await applyDailyContribution(contribution({ appId: app.id, contributionId: "c-2", deltas: { engagedSeconds: 45, sessionsStarted: 0, sessionsCompleted: 1, sessionsInterrupted: 0, lessonsCompleted: 0 } }));
    const rows = getDb().prepare("select * from analytics_daily_buffer").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0].engaged_seconds).toBe(75);
    expect(rows[0].sessions_started).toBe(1);
    expect(rows[0].sessions_completed).toBe(1);
  });

  it("never writes the raw learner id — only the date-specific HMAC key (AT-AN-001-04/05)", async () => {
    const app = await activeApp();
    await applyDailyContribution(contribution({ appId: app.id, learnerId: "learner-secret" }));
    const row = getDb().prepare("select * from analytics_daily_buffer").get() as Record<string, unknown>;
    expect(Object.values(row).some((v) => typeof v === "string" && v.includes("learner-secret"))).toBe(false);
    expect(row.learner_daily_key).toBe(learnerDailyKey("learner-secret", "2026-08-04"));
  });

  it("retrying the same contributionId does not double count (AT-AN-001-08)", async () => {
    const app = await activeApp();
    const payload = contribution({ appId: app.id, contributionId: "retry-me" });
    const first = await applyDailyContribution(payload);
    const second = await applyDailyContribution(payload);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    const row = getDb().prepare("select * from analytics_daily_buffer").get() as Record<string, unknown>;
    expect(row.engaged_seconds).toBe(60);
    expect(row.sessions_started).toBe(1);
  });

  it("rejects a contribution for a soft-deleted app (AT-AN-001-21)", async () => {
    const app = await activeApp();
    await softDeleteApp(ADMIN, app.id, {
      expectedVersion: app.version, confirmationAppKey: app.appKey, reasonCode: "retired", idempotencyKey: key(900),
    });
    await expect(applyDailyContribution(contribution({ appId: app.id }))).rejects
      .toThrow(new AnalyticsError("APP_NOT_ACTIVE"));
    const rows = getDb().prepare("select * from analytics_daily_buffer").all();
    expect(rows).toHaveLength(0);
  });

  it("rejects a contribution for an unknown app", async () => {
    await expect(applyDailyContribution(contribution({ appId: "does-not-exist" }))).rejects
      .toThrow(new AnalyticsError("APP_NOT_FOUND"));
  });

  it("rejects an unknown level key but permits the reserved unassigned bucket", async () => {
    const app = await activeApp();
    await expect(applyDailyContribution(contribution({ appId: app.id, levelKey: "invented-level" }))).rejects
      .toThrow(new AnalyticsError("UNKNOWN_LEVEL_KEY"));
    expect(getDb().prepare("select * from analytics_daily_buffer").all()).toHaveLength(0);

    getDb().prepare("update app_analytics_levels set status='inactive' where app_id=? and level_key='level-1'")
      .run(app.id);
    await expect(applyDailyContribution(contribution({ appId: app.id, levelKey: "level-1" }))).rejects
      .toThrow(new AnalyticsError("UNKNOWN_LEVEL_KEY"));

    await applyDailyContribution(contribution({
      appId: app.id, levelKey: "unassigned", contributionId: "unassigned-event",
    }));
  });

  it("fails closed with no buffer row when the analytics secret is missing (AT-AN-001-29)", async () => {
    const app = await activeApp();
    delete process.env.ANALYTICS_HMAC_SECRET;
    await expect(applyDailyContribution(contribution({ appId: app.id }))).rejects
      .toThrow(new AnalyticsError("ANALYTICS_SECRET_MISSING"));
    const rows = getDb().prepare("select * from analytics_daily_buffer").all();
    expect(rows).toHaveLength(0);
    const receipts = getDb().prepare("select * from analytics_contribution_receipts").all();
    expect(receipts).toHaveLength(0);
  });
});

describe("applyTrustedCounterEvent", () => {
  it("derives the aggregate dimensions from the session and never accepts engaged time", async () => {
    const app = await activeApp();
    const learner = (await createLearner(ADMIN, {
      displayName: "Asha",
      dateOfBirth: "2018-03-10",
      idempotencyKey: key(950),
    }, "2026-08-05")).learner;
    const now = new Date("2026-08-04T18:40:00.000Z"); // 2026-08-05 in Kolkata
    getDb().prepare(
      `insert into learner_sessions(
        id,learner_id,app_id,parent_user_id,parent_session_id,device_session_id,
        week_key,week_timezone,weekly_slot_number,source,status,schedule_authorization_id,
        started_at,resume_token_hash,current_level_key,created_at,updated_at)
       values(?,?,?,?,?,?,'2026-W32','Asia/Kolkata',1,'normal','active','schedule-1',?,?,?,?,?)`,
    ).run("session-derived-event", learner.id, app.id, ADMIN, "parent-session-1", "device-1",
      now.toISOString(), "resume-hash", "level-7", now.toISOString(), now.toISOString());

    await applyTrustedCounterEvent({
      learnerSessionId: "session-derived-event",
      contributionId: "trusted-event-1",
      eventType: "lesson_completed",
    }, now);

    const row = getDb().prepare("select * from analytics_daily_buffer").get() as Record<string, unknown>;
    expect(row.activity_date).toBe("2026-08-05");
    expect(row.app_id).toBe(app.id);
    expect(row.level_key).toBe("level-7");
    expect(row.age_band).toBe("8_9");
    expect(row.engaged_seconds).toBe(0);
    expect(row.lessons_completed).toBe(1);
    expect(row.learner_daily_key).toBe(learnerDailyKey(learner.id, "2026-08-05"));
  });
});
