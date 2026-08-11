import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearnerLauncher } from "@/components/learner-home/learner-launcher";
import type { VersionedLearnerHomeResponse } from "@/lib/learner-home/contracts";

const initialData: VersionedLearnerHomeResponse = {
  learnerId: "learner-1", launcherVersion: "version-1", serverTime: "2026-08-11T00:00:00.000Z",
  composedAt: "2026-08-11T00:00:00.000Z", nextRecheckAt: null, cacheMaxAgeSeconds: 60,
  selectedLearnerContextVersion: 4, activeSession: null,
  cards: [{ appId: "app-1", appKey: "math", appName: "Magical Math", iconAssetKey: null,
    shortDescription: null, status: "active", progress: null, progressState: "learning_not_started",
    lastUpdatedHint: false, session: { availableStandardSessions: 8, nearestStandardExpiryDate: null,
      technicalCreditsAvailable: 0, activeOrResumableSession: null }, eligibility: { canStart: true,
      canResume: false, blockedReason: null }, primaryAction: "start" }],
};

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
  window.sessionStorage.clear();
});

describe("UL-003 launcher freshness UI", () => {
  it("retains safe cards offline, disables authority-requiring actions and exposes a 44px named refresh control", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    render(<LearnerLauncher learnerName="Asha" learnerId="learner-1" contextVersion={4}
      contextBinding="binding-1" initialData={initialData} />);
    expect(screen.getByText("Magical Math")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/Offline — Start and Resume are unavailable/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    const refresh = screen.getByRole("button", { name: "Refresh learning apps" });
    expect(refresh).toHaveClass("min-h-[44px]", "min-w-[44px]");
  });
});
