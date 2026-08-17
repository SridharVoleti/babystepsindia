import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { activateApp, createApp, editApp } from "@/lib/db/app-registry-repo";
import { applyDailyContribution, registerAnalyticsLevel } from "@/lib/db/analytics-contribution-repo";
import { runDailyAggregation } from "@/lib/db/analytics-run-repo";
import { STAFF_ROLE_KEYS } from "@/lib/staff-identity/contracts";
import {
  AnalyticsScopeExceededError, MIN_COHORT_SIZE, composeScopedDailyAnalytics, composeScopedDailyAnalyticsCsv,
  resolveAnalyticsScope,
} from "@/lib/analytics/reporting";
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
    shortDescription: "desc", iconAssetKey: "icon-chess-piece", category: "learning", owningTeam: "platform",
    expectedVersion: created.version, idempotencyKey: key(101),
  });
  const activated = await activateApp(
    ADMIN, edited.id, { expectedVersion: edited.version, idempotencyKey: key(201) }, readyAdapter,
  );
  registerAnalyticsLevel(activated.id, "level-1");
  return activated;
}

async function seedCohort(appId: string, activityDate: string, learnerCount: number) {
  for (let i = 0; i < learnerCount; i++) {
    applyDailyContribution({
      activityDate, learnerId: `learner-${i}`, appId, levelKey: "level-1", ageBand: "8_9",
      contributionId: `c-${activityDate}-${i}`,
      deltas: { engagedSeconds: 60, sessionsStarted: 1, sessionsCompleted: 1, sessionsInterrupted: 0, lessonsCompleted: 1 },
    });
  }
  runDailyAggregation(activityDate, new Date(`${activityDate}T00:20:00.000Z`));
}

const SUPER_ADMIN = [...STAFF_ROLE_KEYS];
const OPS_ONLY = ["operations_administrator"];

describe("AN-004 resolveAnalyticsScope", () => {
  it("only a principal holding all 4 staff roles resolves to 'unrestricted'", () => {
    expect(resolveAnalyticsScope(SUPER_ADMIN)).toBe("unrestricted");
    expect(resolveAnalyticsScope(OPS_ONLY)).toBe("app_level");
    expect(resolveAnalyticsScope(["operations_administrator", "billing_administrator"])).toBe("app_level");
    expect(resolveAnalyticsScope([])).toBe("app_level");
  });
});

describe("AN-004 cohort suppression (MIN_COHORT_SIZE = 5)", () => {
  it("AT-AN-004-02: a cohort below 5 is suppressed — no count fields exposed", async () => {
    const app = await activeApp();
    await seedCohort(app.id, "2026-08-10", 3);

    const result = composeScopedDailyAnalytics(SUPER_ADMIN, { from: "2026-08-10", to: "2026-08-10" });
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0]).toMatchObject({
      suppressed: true, activeLearners: null, sessionsStarted: null, sessionsCompleted: null,
      sessionsInterrupted: null, engagedSeconds: null, lessonsCompleted: null,
    });
    expect(result.levels![0]).toMatchObject({ suppressed: true, activeLearners: null });
  });

  it("a cohort of exactly MIN_COHORT_SIZE is not suppressed", async () => {
    const app = await activeApp();
    await seedCohort(app.id, "2026-08-10", MIN_COHORT_SIZE);

    const result = composeScopedDailyAnalytics(SUPER_ADMIN, { from: "2026-08-10", to: "2026-08-10" });
    expect(result.apps[0]).toMatchObject({ suppressed: false, activeLearners: MIN_COHORT_SIZE });
  });

  it("a cohort of MIN_COHORT_SIZE - 1 is suppressed", async () => {
    const app = await activeApp();
    await seedCohort(app.id, "2026-08-10", MIN_COHORT_SIZE - 1);

    const result = composeScopedDailyAnalytics(SUPER_ADMIN, { from: "2026-08-10", to: "2026-08-10" });
    expect(result.apps[0].suppressed).toBe(true);
  });
});

describe("AN-004 role scoping", () => {
  it("AT-AN-004-01: a non-Super-Admin role requesting a level-key filter is denied, not silently downgraded", async () => {
    const app = await activeApp();
    await seedCohort(app.id, "2026-08-10", MIN_COHORT_SIZE);

    expect(() => composeScopedDailyAnalytics(OPS_ONLY, { from: "2026-08-10", levelKey: "level-1" }))
      .toThrow(AnalyticsScopeExceededError);
  });

  it("a non-Super-Admin role without a level-key filter gets app-level totals only — no 'levels' data at all", async () => {
    const app = await activeApp();
    await seedCohort(app.id, "2026-08-10", MIN_COHORT_SIZE);

    const result = composeScopedDailyAnalytics(OPS_ONLY, { from: "2026-08-10" });
    expect(result.scope).toBe("app_level");
    expect(result.apps).toHaveLength(1);
    expect(result.levels).toBeNull();
  });

  it("Super Admin (all 4 roles) gets both app and level views, unrestricted by a level-key filter", async () => {
    const app = await activeApp();
    await seedCohort(app.id, "2026-08-10", MIN_COHORT_SIZE);

    const result = composeScopedDailyAnalytics(SUPER_ADMIN, { from: "2026-08-10", levelKey: "level-1" });
    expect(result.scope).toBe("unrestricted");
    expect(result.levels).toHaveLength(1);
  });
});

describe("AN-004 CSV export (AT-AN-004-03)", () => {
  it("export inherits the same cohort suppression as the interactive view", async () => {
    const app = await activeApp();
    await seedCohort(app.id, "2026-08-10", 2);

    const csv = composeScopedDailyAnalyticsCsv(SUPER_ADMIN, { from: "2026-08-10", to: "2026-08-10" });
    expect(csv).toContain("suppressed");
    expect(csv.split("\n")[1]).toMatch(/,true$/);
    expect(csv).not.toMatch(/,2,/);
  });

  it("export inherits the same role scope — a non-Super-Admin cannot export a level-key breakdown", async () => {
    const app = await activeApp();
    await seedCohort(app.id, "2026-08-10", MIN_COHORT_SIZE);
    expect(() => composeScopedDailyAnalyticsCsv(OPS_ONLY, { from: "2026-08-10", levelKey: "level-1" }))
      .toThrow(AnalyticsScopeExceededError);
  });

  it("export never mutates a source table", async () => {
    const app = await activeApp();
    await seedCohort(app.id, "2026-08-10", MIN_COHORT_SIZE);
    const { getDb } = await import("@/lib/db/client");
    const before = getDb().prepare("select count(*) n from analytics_daily_app").get();
    composeScopedDailyAnalyticsCsv(SUPER_ADMIN, { from: "2026-08-10" });
    expect(getDb().prepare("select count(*) n from analytics_daily_app").get()).toEqual(before);
  });
});
