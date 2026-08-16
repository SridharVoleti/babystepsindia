import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminApi: vi.fn(async () => ({
    ok: true,
    session: { sub: "admin-1", email: "admin@example.com" },
    principal: {},
  })),
  requireReauth: vi.fn<() => Response | null>(() => null),
  listDailyAppAggregates: vi.fn(() => []),
  listDailyLevelAggregates: vi.fn(() => []),
  listDailyRuns: vi.fn(() => []),
  runDailyAggregation: vi.fn(() => ({ status: "completed" })),
}));

vi.mock("@/lib/auth/admin-api-guard", () => ({
  requireAdminApi: mocks.requireAdminApi,
  requireReauth: mocks.requireReauth,
}));
vi.mock("@/lib/auth/internal-service-guard", () => ({
  requireInternalService: vi.fn(async () => ({ ok: true, principal: {} })),
}));
vi.mock("@/lib/auth/rate-limit", () => ({ checkRateLimit: vi.fn(() => true) }));
vi.mock("@/lib/db/analytics-admin-repo", () => ({
  listDailyAppAggregates: mocks.listDailyAppAggregates,
  listDailyLevelAggregates: mocks.listDailyLevelAggregates,
  listDailyRuns: mocks.listDailyRuns,
}));
vi.mock("@/lib/db/analytics-run-repo", () => ({ runDailyAggregation: mocks.runDailyAggregation }));

import { GET as getDailyAggregates } from "@/app/v1/admin/analytics/daily/route";
import { GET as getDailyRuns } from "@/app/v1/admin/analytics/runs/route";
import { POST as retryDailyRun } from "@/app/v1/admin/analytics/runs/[activityDate]/retry/route";
import { POST as invokeDailyRun } from "@/app/v1/internal/analytics/daily-runs/[activityDate]/route";

describe("analytics calendar-date route boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["daily aggregate from filter", () => getDailyAggregates(new Request("http://localhost/v1/admin/analytics/daily?from=2026-02-29"))],
    ["daily aggregate to filter", () => getDailyAggregates(new Request("http://localhost/v1/admin/analytics/daily?to=2026-04-31"))],
    ["run-list from filter", () => getDailyRuns(new Request("http://localhost/v1/admin/analytics/runs?from=2026-02-29"))],
    ["run-list to filter", () => getDailyRuns(new Request("http://localhost/v1/admin/analytics/runs?to=2026-04-31"))],
  ])("rejects an impossible %s without broadening the query", async (_label, request) => {
    const response = await request();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "DATE_FILTER_INVALID" });
    expect(mocks.listDailyAppAggregates).not.toHaveBeenCalled();
    expect(mocks.listDailyLevelAggregates).not.toHaveBeenCalled();
    expect(mocks.listDailyRuns).not.toHaveBeenCalled();
  });

  it.each([
    ["admin retry", (activityDate: string) => retryDailyRun(new Request("http://localhost"), { params: { activityDate } })],
    ["internal scheduler", (activityDate: string) => invokeDailyRun(new Request("http://localhost"), { params: { activityDate } })],
  ])("rejects an impossible date at the %s boundary", async (_label, request) => {
    const response = await request("2026-02-29");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "ACTIVITY_DATE_INVALID" });
    expect(mocks.runDailyAggregation).not.toHaveBeenCalled();
  });

  it("accepts a valid leap day at every route boundary", async () => {
    expect((await getDailyAggregates(new Request("http://localhost/v1/admin/analytics/daily?from=2024-02-29"))).status)
      .toBe(200);
    expect((await getDailyRuns(new Request("http://localhost/v1/admin/analytics/runs?to=2024-02-29"))).status)
      .toBe(200);
    expect((await retryDailyRun(new Request("http://localhost", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: "CorrectHorse1!" }),
    }), { params: { activityDate: "2024-02-29" } })).status)
      .toBe(200);
    expect((await invokeDailyRun(new Request("http://localhost"), { params: { activityDate: "2024-02-29" } })).status)
      .toBe(200);
  });

  it("requires the exact canonical action for each admin read API", async () => {
    await getDailyAggregates(new Request("http://localhost/v1/admin/analytics/daily"));
    await getDailyRuns(new Request("http://localhost/v1/admin/analytics/runs"));
    expect(mocks.requireAdminApi).toHaveBeenNthCalledWith(1, "admin.analytics.daily.read");
    expect(mocks.requireAdminApi).toHaveBeenNthCalledWith(2, "admin.analytics.runs.read");
  });

  it("requires a live two-factor reauth receipt for every retry (AD-001)", async () => {
    mocks.requireReauth.mockReturnValueOnce(Response.json({ error: "REAUTHENTICATION_REQUIRED" }, { status: 401 }));
    const response = await retryDailyRun(new Request("http://localhost", { method: "POST" }),
      { params: { activityDate: "2026-08-04" } });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "REAUTHENTICATION_REQUIRED" });
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.analytics.run.retry");
    expect(mocks.runDailyAggregation).not.toHaveBeenCalled();
  });

  it("runs an authorized retry only after the reauth receipt check passes", async () => {
    const response = await retryDailyRun(new Request("http://localhost", { method: "POST" }),
      { params: { activityDate: "2026-08-04" } });

    expect(response.status).toBe(200);
    expect(mocks.requireReauth).toHaveBeenCalled();
    expect(mocks.runDailyAggregation).toHaveBeenCalledWith("2026-08-04");
  });
});
