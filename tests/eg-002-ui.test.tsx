import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsistencyHistory } from "@/components/consistency/consistency-history";
import { LearnerLauncher } from "@/components/learner-home/learner-launcher";
import type { ConsistencyCurrentView, ConsistencyHistoryView } from "@/lib/consistency/service";
import type { VersionedLearnerHomeResponse } from "@/lib/learner-home/contracts";

const current: ConsistencyCurrentView = {
  appId: "app-math", appKey: "math", appName: "Magical Math", currentStreakWeeks: 3,
  longestStreakWeeks: 5, currentWeekProgress: 1, target: 2, currentWeekKey: "2026-W33",
  currentWeekStartAt: "2026-08-09T18:30:00.000Z", currentWeekEndAt: "2026-08-16T18:30:00.000Z",
  status: "open", stateVersion: 4,
};

const history: ConsistencyHistoryView[] = [{
  appId: "app-math", appName: "Magical Math", weeklyKey: "2026-W32",
  weeklyStartAt: "2026-08-02T18:30:00.000Z", weeklyEndAt: "2026-08-09T18:30:00.000Z",
  qualifyingStandardSessions: 1, target: 2, status: "incomplete_reset", completedAt: null,
}];

afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe("EG-002 per-app consistency presentation", () => {
  it("AT-EG-002-37..44 presents responsive per-app weekly state with neutral accessible text", () => {
    const { container } = render(<ConsistencyHistory apps={[current]} initialHistory={history}
      initialCursor={null} endpoint="/v1/learner-consistency" />);
    expect(screen.getByRole("heading", { name: "This week by app" })).toBeVisible();
    expect(screen.getByText("1 of 2 this week")).toBeVisible();
    expect(screen.getByText("Current streak: 3 weeks")).toBeVisible();
    expect(screen.getByText("Weekly cadence was not completed; a new streak can begin this week")).toBeVisible();
    expect(container.querySelector(".grid-cols-1")).not.toBeNull();
    expect(container.textContent).not.toMatch(/global streak|daily streak|combined score|points|xp|flame|failed/i);
  });

  it("API-EG-012 keeps consistency secondary on the current app card", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const data: VersionedLearnerHomeResponse = {
      learnerId: "learner-1", launcherVersion: "v1", serverTime: "2026-08-12T10:00:00Z",
      composedAt: "2026-08-12T10:00:00Z", nextRecheckAt: null, cacheMaxAgeSeconds: 60,
      selectedLearnerContextVersion: 1, activeSession: null, cards: [{
        appId: "app-math", appKey: "math", appName: "Magical Math", iconAssetKey: null,
        shortDescription: null, status: "active", progress: { currentLevel: "L2", efficiencyStars: 4,
          milestone: "Numbers", nextDestination: "L3" }, progressState: "summary_available", consistency: current,
        lastUpdatedHint: false, operationalAvailability: { state: "available", availabilityVersion: 2,
          learnerMessage: null, nextMaintenanceStartAt: null, maintenanceEndsAt: null, safeStartUntil: null,
          expectedReturnAt: null, startBlocked: false }, session: { availableStandardSessions: 1,
          nearestStandardExpiryDate: null, technicalCreditsAvailable: 0, activeOrResumableSession: null },
        eligibility: { canStart: true, canResume: false, blockedReason: null }, primaryAction: "start",
      }],
    };
    render(<LearnerLauncher learnerName="Asha" learnerId="learner-1" contextVersion={1}
      contextBinding="binding" initialData={data} />);
    const consistency = screen.getByRole("status", { name: "Magical Math weekly consistency" });
    expect(consistency).toHaveTextContent("1 of 2 sessions this week");
    expect(consistency).toHaveTextContent("3-week streak");
    expect(screen.getByRole("link", { name: "View weekly consistency" }))
      .toHaveAttribute("href", "/learner/consistency");
    expect(consistency.compareDocumentPosition(screen.getByText("Level: L2")) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });
});
