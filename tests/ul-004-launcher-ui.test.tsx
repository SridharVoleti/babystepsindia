import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnerLauncher } from "@/components/learner-home/learner-launcher";
import type { VersionedLearnerHomeResponse } from "@/lib/learner-home/contracts";

afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });

describe("UL-004 launcher availability UI", () => {
  it("keeps an unavailable current app visible with status before progress", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const initialData: VersionedLearnerHomeResponse = {
      learnerId: "learner-1", launcherVersion: "v1", serverTime: "2026-08-11T10:00:00Z",
      composedAt: "2026-08-11T10:00:00Z", nextRecheckAt: "2026-08-11T10:05:00Z",
      cacheMaxAgeSeconds: 60, selectedLearnerContextVersion: 1, activeSession: null,
      cards: [{ appId: "app-1", appKey: "math", appName: "Magical Math", iconAssetKey: null,
        shortDescription: null, status: "temporarily_unavailable", progress: { currentLevel: "L2",
          efficiencyStars: 4, milestone: "Numbers", nextDestination: "L3" }, progressState: "summary_available",
        lastUpdatedHint: false, operationalAvailability: { state: "maintenance_soon", availabilityVersion: 2,
          learnerMessage: "A short planned update.", nextMaintenanceStartAt: "2026-08-11T11:00:00Z",
          maintenanceEndsAt: "2026-08-11T11:30:00Z", safeStartUntil: "2026-08-11T09:55:00Z",
          expectedReturnAt: "2026-08-11T11:30:00Z", startBlocked: true },
        session: { availableStandardSessions: 2, nearestStandardExpiryDate: null, technicalCreditsAvailable: 0,
          activeOrResumableSession: null }, eligibility: { canStart: false, canResume: false,
          blockedReason: "maintenance_starts_soon" }, primaryAction: "none" }],
    };
    render(<LearnerLauncher learnerName="Asha" learnerId="learner-1" contextVersion={1}
      contextBinding="binding" initialData={initialData} />);
    expect(screen.getByText("Magical Math")).toBeVisible();
    const status = screen.getByRole("status", { name: "Operational availability: Maintenance starts soon" });
    expect(status).toHaveTextContent("A short planned update.");
    expect(status).toHaveTextContent("Starts:");
    expect(status).toHaveTextContent("Expected return:");
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByText("Level: L2")).toBeVisible();
    expect(status.compareDocumentPosition(screen.getByText("Level: L2")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not fabricate a return estimate for restoring service", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const data: VersionedLearnerHomeResponse = { learnerId: "learner-1", launcherVersion: "v2",
      serverTime: "2026-08-11T10:00:00Z", composedAt: "2026-08-11T10:00:00Z", nextRecheckAt: null,
      cacheMaxAgeSeconds: 60, selectedLearnerContextVersion: 1, activeSession: null, cards: [{
        appId: "app-2", appKey: "read", appName: "Reading", iconAssetKey: null, shortDescription: null,
        status: "temporarily_unavailable", progress: null, progressState: "learning_not_started",
        lastUpdatedHint: false, operationalAvailability: { state: "restoring", availabilityVersion: 3,
          learnerMessage: null, nextMaintenanceStartAt: null, maintenanceEndsAt: null, safeStartUntil: null,
          expectedReturnAt: null, startBlocked: true }, session: { availableStandardSessions: 2,
          nearestStandardExpiryDate: null, technicalCreditsAvailable: 0, activeOrResumableSession: null },
        eligibility: { canStart: false, canResume: false, blockedReason: "restoring_service" }, primaryAction: "none",
      }] };
    render(<LearnerLauncher learnerName="Asha" learnerId="learner-1" contextVersion={1}
      contextBinding="binding-2" initialData={data} />);
    expect(screen.getByText("Restoring service")).toBeVisible();
    expect(screen.queryByText(/Expected return:/)).not.toBeInTheDocument();
  });
});
