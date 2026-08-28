// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { LearnerHomeCard } from "@/lib/learner-home/contracts";

// Isolate the controller's fetch orchestration by stubbing the presentational
// launcher — it just surfaces a button that invokes the injected callback.
vi.mock("@/components/learner-home/learner-launcher", () => ({
  LearnerLauncher: ({ onPrimaryAction }: { onPrimaryAction: (card: LearnerHomeCard) => void }) => (
    <>
      <button onClick={() => onPrimaryAction({ appId: "chess-masters", primaryAction: "start" } as LearnerHomeCard)}>
        start
      </button>
      <button onClick={() => onPrimaryAction({ appId: "chess-masters", primaryAction: "resume" } as LearnerHomeCard)}>
        resume
      </button>
    </>
  ),
}));

import { LearnerLaunchController } from "@/components/learner-home/launch-controller";

const props = {
  learnerName: "Asha", learnerId: "learner-1", contextVersion: 0, contextBinding: "cb",
  initialData: { cards: [], recentAchievements: [], composedAt: "2026-08-28T00:00:00.000Z" } as never,
};

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
});

describe("LP-004 LearnerLaunchController", () => {
  it("starts a session then dispatches the launch, writing the returned handoff HTML", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sessionId: "session-9" }) })
      .mockResolvedValueOnce({ ok: true, text: async () => "<form id='handoff'></form>" });
    vi.stubGlobal("fetch", fetchMock);
    const open = vi.fn(); const write = vi.fn(); const close = vi.fn();
    vi.stubGlobal("document", Object.assign(document, { open, write, close }));

    render(<LearnerLaunchController {...props} />);
    fireEvent.click(screen.getByText("start"));

    await waitFor(() => expect(write).toHaveBeenCalledWith("<form id='handoff'></form>"));
    expect(fetchMock.mock.calls[0][0]).toBe("/v1/learner-sessions");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      appId: "chess-masters", idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
    expect(fetchMock.mock.calls[1][0]).toBe("/v1/learner-sessions/session-9/launch-dispatch");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      expectedVersion: 1, idempotencyKey: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("surfaces the server error code when starting the session fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "APP_NOT_PUBLISHED" }) }));
    render(<LearnerLaunchController {...props} />);
    fireEvent.click(screen.getByText("start"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("APP_NOT_PUBLISHED"));
  });

  it("does not dispatch a launch for a resume action", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<LearnerLaunchController {...props} />);
    fireEvent.click(screen.getByText("resume"));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/inside the app/i));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
