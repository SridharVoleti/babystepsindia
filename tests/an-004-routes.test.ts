// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStaffSession: vi.fn() }));
vi.mock("@/lib/staff-identity/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staff-identity/session")>()),
  getStaffSession: mocks.getStaffSession,
}));

import { GET as getDaily } from "@/app/v1/admin/analytics/daily/route";
import { GET as getExport } from "@/app/v1/admin/analytics/daily/export/route";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { activateApp, createApp, editApp } from "@/lib/db/app-registry-repo";
import { applyDailyContribution, registerAnalyticsLevel } from "@/lib/db/analytics-contribution-repo";
import { runDailyAggregation } from "@/lib/db/analytics-run-repo";
import { STAFF_ROLE_KEYS } from "@/lib/staff-identity/contracts";
import type { EnvironmentReadinessAdapter } from "@/lib/app-registry/readiness-adapter";

let ADMIN: string;

beforeEach(async () => {
  useInMemoryDb();
  mocks.getStaffSession.mockReset();
  process.env.ANALYTICS_HMAC_SECRET = "test-only-analytics-secret-32-bytes-min";
  ADMIN = (await sqliteAuthAdapter.signUp("admin-actor@example.com", "CorrectHorse1!")).user.id;
});

function key(n: number) {
  return `${"1".repeat(8)}-1111-4111-8111-${String(n).padStart(12, "0")}`;
}

const readyAdapter: EnvironmentReadinessAdapter = { checkReady: async () => ({ ready: true }) };

async function activeAppWithCohort(learnerCount: number, activityDate = "2026-08-10") {
  const created = createApp(ADMIN, { appKey: "chess-master", displayName: "Chess Master", idempotencyKey: key(1) });
  const edited = editApp(ADMIN, created.id, {
    shortDescription: "desc", iconAssetKey: "icon-chess-piece", category: "learning", owningTeam: "platform",
    expectedVersion: created.version, idempotencyKey: key(101),
  });
  const activated = await activateApp(
    ADMIN, edited.id, { expectedVersion: edited.version, idempotencyKey: key(201) }, readyAdapter,
  );
  registerAnalyticsLevel(activated.id, "level-1");
  for (let i = 0; i < learnerCount; i++) {
    applyDailyContribution({
      activityDate, learnerId: `learner-${i}`, appId: activated.id, levelKey: "level-1", ageBand: "8_9",
      contributionId: `c-${i}`,
      deltas: { engagedSeconds: 60, sessionsStarted: 1, sessionsCompleted: 1, sessionsInterrupted: 0, lessonsCompleted: 1 },
    });
  }
  await runDailyAggregation(activityDate, new Date(`${activityDate}T00:20:00.000Z`));
  return activated;
}

describe("AN-004 GET /v1/admin/analytics/daily — role scoping over the real DB", () => {
  it("AT-AN-004-01: operations_administrator requesting a levelKey filter is denied with ANALYTICS_SCOPE_EXCEEDED", async () => {
    await activeAppWithCohort(5);
    mocks.getStaffSession.mockResolvedValue(seedStaffSession(["operations_administrator"]));

    const response = await getDaily(new Request("http://localhost/v1/admin/analytics/daily?levelKey=level-1"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "ANALYTICS_SCOPE_EXCEEDED" });
  });

  it("operations_administrator without a levelKey filter gets app totals with levels: null", async () => {
    await activeAppWithCohort(5);
    mocks.getStaffSession.mockResolvedValue(seedStaffSession(["operations_administrator"]));

    const response = await getDaily(new Request("http://localhost/v1/admin/analytics/daily"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.scope).toBe("app_level");
    expect(body.levels).toBeNull();
    expect(body.apps).toHaveLength(1);
  });

  it("Super Admin (all 4 roles) can request a levelKey breakdown", async () => {
    await activeAppWithCohort(5);
    mocks.getStaffSession.mockResolvedValue(seedStaffSession([...STAFF_ROLE_KEYS]));

    const response = await getDaily(new Request("http://localhost/v1/admin/analytics/daily?levelKey=level-1"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.scope).toBe("unrestricted");
    expect(body.levels).toHaveLength(1);
  });

  it("a small cohort is suppressed in the route response", async () => {
    await activeAppWithCohort(2);
    mocks.getStaffSession.mockResolvedValue(seedStaffSession([...STAFF_ROLE_KEYS]));

    const response = await getDaily(new Request("http://localhost/v1/admin/analytics/daily"));
    const body = await response.json();
    expect(body.apps[0]).toMatchObject({ suppressed: true, activeLearners: null });
  });
});

describe("AN-004 GET /v1/admin/analytics/daily/export", () => {
  it("denies export to a role without the export action", async () => {
    mocks.getStaffSession.mockResolvedValue(seedStaffSession(["billing_administrator"]));
    const response = await getExport(new Request("http://localhost/v1/admin/analytics/daily/export"));
    expect(response.status).toBe(403);
  });

  it("AT-AN-004-03: returns CSV inheriting the same suppression/scope as the interactive view", async () => {
    await activeAppWithCohort(2);
    mocks.getStaffSession.mockResolvedValue(seedStaffSession(["operations_administrator"]));

    const response = await getExport(new Request("http://localhost/v1/admin/analytics/daily/export"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv");
    const csv = await response.text();
    expect(csv).toContain("suppressed");
    expect(csv.split("\n")[1]).toMatch(/,true$/);
  });

  it("a scoped role cannot export a level-key breakdown", async () => {
    await activeAppWithCohort(5);
    mocks.getStaffSession.mockResolvedValue(seedStaffSession(["operations_administrator"]));

    const response = await getExport(new Request("http://localhost/v1/admin/analytics/daily/export?levelKey=level-1"));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "ANALYTICS_SCOPE_EXCEEDED" });
  });
});
