import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminPermission: vi.fn(async () => ({ sub: "admin-1" })),
  listApps: vi.fn(() => []),
  listDailyAppAggregates: vi.fn(() => []),
  listDailyLevelAggregates: vi.fn(() => []),
  listDailyRuns: vi.fn(() => []),
}));

vi.mock("@/lib/auth/guards", () => ({ requireAdminPermission: mocks.requireAdminPermission }));
vi.mock("@/lib/db/app-registry-repo", () => ({ listApps: mocks.listApps }));
vi.mock("@/lib/db/analytics-admin-repo", () => ({
  listDailyAppAggregates: mocks.listDailyAppAggregates,
  listDailyLevelAggregates: mocks.listDailyLevelAggregates,
  listDailyRuns: mocks.listDailyRuns,
}));

import AnalyticsPage from "@/app/admin/analytics/page";
import AnalyticsRunsPage from "@/app/admin/analytics/runs/page";

describe("analytics page date-filter boundaries", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["aggregate page", () => AnalyticsPage({ searchParams: { from: "2026-02-29" } }), "admin.analytics.daily.read"],
    ["run page", () => AnalyticsRunsPage({ searchParams: { to: "2026-04-31" } }), "admin.analytics.runs.read"],
  ])("fails closed for an impossible date on the %s", async (_label, page, expectedAction) => {
    render(await page());
    expect(screen.getByRole("heading", { name: "Invalid date filter" })).toBeInTheDocument();
    expect(mocks.requireAdminPermission).toHaveBeenCalledWith(expectedAction);
    expect(mocks.listDailyAppAggregates).not.toHaveBeenCalled();
    expect(mocks.listDailyLevelAggregates).not.toHaveBeenCalled();
    expect(mocks.listDailyRuns).not.toHaveBeenCalled();
  });

  it("passes a valid leap-day filter to the read model after permission succeeds", async () => {
    render(await AnalyticsPage({ searchParams: { from: "2024-02-29", to: "2024-02-29" } }));
    expect(mocks.requireAdminPermission).toHaveBeenCalledWith("admin.analytics.daily.read");
    expect(mocks.listDailyAppAggregates).toHaveBeenCalledWith(expect.objectContaining({
      from: "2024-02-29",
      to: "2024-02-29",
    }));
  });
});
