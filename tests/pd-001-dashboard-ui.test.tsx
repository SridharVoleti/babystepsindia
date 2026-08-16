import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireParentManagement: vi.fn(),
  composeParentDashboard: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({ requireParentManagement: mocks.requireParentManagement }));
vi.mock("@/lib/parent-dashboard/service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/parent-dashboard/service")>("@/lib/parent-dashboard/service");
  return { ...actual, composeParentDashboard: mocks.composeParentDashboard };
});

import AccountPage from "@/app/account/page";

const baseLearner = {
  learnerId: "learner-1", displayName: "Asha", appsOnTrack: { completed: 1, total: 2 },
  currentApps: [{
    appId: "app-1", appKey: "app-1", appName: "ChessQuest", iconAssetKey: null, shortDescription: null,
    status: "active" as const, progress: { currentLevel: "Level 3", efficiencyStars: 2, milestone: null,
      nextDestination: "Level 4" }, progressState: "summary_available" as const, lastUpdatedHint: false,
    consistency: { appId: "app-1", appKey: "app-1", appName: "ChessQuest", currentStreakWeeks: 4,
      longestStreakWeeks: 4, currentWeekProgress: 1 as const, target: 2 as const, currentWeekKey: "2026-W33",
      currentWeekStartAt: "2026-08-10T00:00:00.000Z", currentWeekEndAt: "2026-08-17T00:00:00.000Z",
      status: "open" as const, stateVersion: 1 },
  }],
  recentAchievements: [], attentionPreview: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireParentManagement.mockResolvedValue({ session: { sub: "parent-1", email: "parent@example.com" } });
  mocks.composeParentDashboard.mockReturnValue({
    composedAt: "t", version: "v1", learners: [baseLearner], partialErrors: {},
  });
});

describe("PD-001 dashboard UI (AT-PD-001-19/36/37/38/39/41/42)", () => {
  it("AT-19/20: 'Open learner' routes to the AU-002 unlock page, never a direct app/learner-home bypass", async () => {
    render(await AccountPage());
    const openLink = screen.getByRole("link", { name: /Open Asha/ });
    expect(openLink.getAttribute("href")).toBe("/account/learners/learner-1/unlock");
    // no direct learner-home/app route is ever linked from the dashboard itself.
    const allHrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(allHrefs.some((href) => href === "/learner" || /\/apps\/launch/.test(href ?? ""))).toBe(false);
  });

  it("AT-36/37: renders a deliberate desktop app grid that becomes a single-column mobile stack, not a shrunk table", async () => {
    const { container } = render(await AccountPage());
    const grid = container.querySelector(".grid");
    expect(grid).toBeTruthy();
    expect(grid?.className).toMatch(/grid-cols-1/);
    expect(grid?.className).toMatch(/sm:grid-cols-2/);
    expect(container.querySelector("table")).toBeNull();
  });

  it("AT-38: every interactive element is a real >=44px touch target", async () => {
    const learnerWithAttention = { ...baseLearner, attentionPreview: [{ learnerId: "learner-1" } as never] };
    mocks.composeParentDashboard.mockReturnValue({
      composedAt: "t", version: "v1", learners: [learnerWithAttention], partialErrors: {},
    });
    const { container } = render(await AccountPage());
    for (const link of container.querySelectorAll("a")) {
      expect(link.className).toMatch(/min-h-\[44px\]/);
    }
  });

  it("AT-39: status is conveyed as a text label, never color alone", async () => {
    render(await AccountPage());
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("AT-41: no loading skeleton fabricates real-looking data — the page is a server component with no client-side placeholder state", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("src/app/account/page.tsx", "utf8");
    expect(source).not.toMatch(/skeleton/i);
    const loadingExists = fs.existsSync("src/app/account/loading.tsx");
    if (loadingExists) {
      const loadingSource = fs.readFileSync("src/app/account/loading.tsx", "utf8");
      expect(loadingSource).not.toMatch(/\d+\/\d+|Active|Level \d/);
    }
  });

  it("AT-42: very long learner/app display names wrap safely instead of overflowing", async () => {
    const longName = "A".repeat(120);
    mocks.composeParentDashboard.mockReturnValue({
      composedAt: "t", version: "v1",
      learners: [{ ...baseLearner, displayName: longName,
        currentApps: [{ ...baseLearner.currentApps[0], appName: longName }] }],
      partialErrors: {},
    });
    const { container } = render(await AccountPage());
    const heading = container.querySelector("h2");
    const cardTitle = container.querySelector("h4");
    expect(heading?.className).toMatch(/break-words/);
    expect(cardTitle?.className).toMatch(/break-words/);
  });

  it("AT-40: a parent with zero learners sees a clear, non-broken empty state", async () => {
    mocks.composeParentDashboard.mockReturnValue({ composedAt: "t", version: "v1", learners: [], partialErrors: {} });
    render(await AccountPage());
    expect(screen.getByText(/No learner profiles yet/)).toBeInTheDocument();
  });
});
