import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnerLauncher } from "@/components/learner-home/learner-launcher";
import { AchievementHistory } from "@/components/achievements/achievement-history";
import type { AchievementView } from "@/lib/achievements/service";
import type { VersionedLearnerHomeResponse } from "@/lib/learner-home/contracts";

const achievement: AchievementView = {
  achievementId: "achievement-1", appId: "app-math", appKey: "math", appName: "Magical Math",
  appIconAssetKey: "icon-open-book", appAchievementKey: "fractions", achievementInstanceKey: "fractions:1",
  title: "Fractions explorer", shortDescription: "Completed the fractions mastery path.",
  badgeAssetKey: "icon-open-book", category: "mastery", earnedAt: "2026-08-12T09:55:00.000Z",
  appAchievementModelVersion: "model-1", recordVersion: 1, acknowledgedAt: "2026-08-12T10:00:00.000Z",
};

afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe("EG-001 learner achievement presentation", () => {
  it("AT-EG-001-39/40/41 shows a separate responsive recent panel with accessible text", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const data: VersionedLearnerHomeResponse = {
      learnerId: "learner-1", launcherVersion: "v1", serverTime: "2026-08-12T10:00:00Z",
      composedAt: "2026-08-12T10:00:00Z", nextRecheckAt: null, cacheMaxAgeSeconds: 60,
      selectedLearnerContextVersion: 1, activeSession: null, recentAchievements: [achievement], cards: [],
    };
    render(<LearnerLauncher learnerName="Asha" learnerId="learner-1" contextVersion={1}
      contextBinding="binding" initialData={data} />);
    expect(screen.getByRole("heading", { name: "Recent achievements" })).toBeVisible();
    expect(screen.getByText("Fractions explorer")).toBeVisible();
    expect(screen.getByText("Magical Math")).toBeVisible();
    const link = screen.getByRole("link", { name: "View all achievements" });
    expect(link).toHaveAttribute("href", "/learner/achievements");
    expect(link.className).toContain("min-h-[44px]");
  });

  it("AT-EG-001-23/24/35 renders app-owned meaning without score or extra-session pressure", () => {
    render(<AchievementHistory initialAchievements={[achievement]} initialCursor={null}
      endpoint="/v1/learner-achievements" />);
    expect(screen.getByRole("heading", { name: "Fractions explorer" })).toBeVisible();
    expect(screen.getByText("Completed the fractions mastery path.")).toBeVisible();
    expect(screen.queryByText(/\bpoints\b|\bxp\b|\brank\b|\brarity\b|do another session|\bleaderboard\b/i))
      .not.toBeInTheDocument();
  });
});
