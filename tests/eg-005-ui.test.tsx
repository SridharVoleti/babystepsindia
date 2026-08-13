// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JourneyTimeline } from "@/components/journey/journey-timeline";

const page = {
  order: "desc" as const,
  nextCursor: null,
  retentionState: { state: "inactive_retention" as const,
    deleteAfter: "2027-08-11T04:30:00.000Z", retainedUntilDate: "2027-08-11" },
  events: [
    { journeyEventId: "event-1", eventType: "lesson_completed" as const,
      eventAt: "2026-08-11T04:30:00.000Z", displayDate: "2026-08-11", title: "Fractions",
      shortDescription: "Completed the fractions lesson.", iconAssetKey: null,
      sourceApp: { appId: "app-1", appName: "Math" } },
    { journeyEventId: "event-2", eventType: "milestone_reached" as const,
      eventAt: "2026-08-10T04:30:00.000Z", displayDate: "2026-08-10", title: "Green belt",
      shortDescription: null, iconAssetKey: "icon-open-book",
      sourceApp: { appId: "app-1", appName: "Math" } },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("EG-005 journey presentation", () => {
  it("AT-EG-005-45/46/47/49/50 renders textual event meaning, dates, and neutral retention copy", () => {
    const { container } = render(<JourneyTimeline initialPage={page} endpoint="/journey" />);
    expect(screen.getByText("Lesson completed")).toBeInTheDocument();
    expect(screen.getByText("Milestone reached")).toBeInTheDocument();
    expect(screen.getByText("Fractions")).toBeInTheDocument();
    expect(screen.getByText(/Journey retained until/)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/points|xp|rank|score|subscribe to save|resubscribe/i);
    expect(container.querySelector("ol")).toHaveClass("space-y-4");
    expect(screen.getByRole("button", { name: "Newest first" })).toHaveClass("min-h-[44px]");
  });

  it("AT-EG-005-12/13 switches order through the read-only endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...page, order: "asc",
      events: [...page.events].reverse() }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<JourneyTimeline initialPage={page} endpoint="/journey" />);
    await userEvent.click(screen.getByRole("button", { name: "Oldest first" }));
    expect(fetchMock).toHaveBeenCalledWith("/journey?order=asc&limit=50",
      { credentials: "same-origin", cache: "no-store" });
    expect(screen.getByRole("button", { name: "Oldest first" })).toHaveAttribute("aria-pressed", "true");
  });
});

