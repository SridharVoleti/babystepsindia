import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SessionExitFlow } from "@/components/session-exit";

function acknowledgement(status: "resumable" | "completed") {
  return {
    sessionId: "session-1", sessionStatus: status, sessionVersion: 2,
    hardExpiresAt: "2026-08-11T11:00:00.000Z", lastAcknowledgedProgressVersion: 2,
    allowedActions: status === "resumable" ? ["resume", "finish_now"] : [],
  };
}

function renderFlow(overrides: Partial<React.ComponentProps<typeof SessionExitFlow>> = {}) {
  const props: React.ComponentProps<typeof SessionExitFlow> = {
    sessionStatus: "active",
    lastAcknowledgedProgressVersion: 1,
    hasMeaningfulUnsavedProgress: false,
    markResumable: vi.fn(async () => acknowledgement("resumable")),
    finishSession: vi.fn(async () => acknowledgement("completed")),
    onAcknowledged: vi.fn(),
    ...overrides,
  };
  return { ...render(<SessionExitFlow {...props} />), props };
}

describe("UL-002 shared session exit flow", () => {
  it("opens without mutation and shows exactly the two explicit primary outcomes", async () => {
    const user = userEvent.setup();
    const { props } = renderFlow();
    await user.click(screen.getByRole("button", { name: "Return to Babysteps" }));
    expect(screen.getByRole("dialog", { name: "Return to Babysteps?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Resume this session later/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Finish session now/ })).toBeInTheDocument();
    expect(props.markResumable).not.toHaveBeenCalled();
    expect(props.finishSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue learning" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("checkpoints meaningful progress once, waits for acknowledgment, and retries the transition with the same key", async () => {
    const user = userEvent.setup();
    const checkpoint = vi.fn(async () => ({ progressVersion: 2 }));
    const markResumable = vi.fn()
      .mockRejectedValueOnce(new Error("The resumable transition was not acknowledged."))
      .mockResolvedValueOnce(acknowledgement("resumable"));
    const onAcknowledged = vi.fn();
    renderFlow({ hasMeaningfulUnsavedProgress: true, checkpoint, markResumable, onAcknowledged });
    await user.click(screen.getByRole("button", { name: "Return to Babysteps" }));
    const resume = screen.getByRole("button", { name: /Resume this session later/ });
    await user.click(resume);
    expect(await screen.findByRole("alert")).toHaveTextContent("Action not completed");
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(markResumable).toHaveBeenCalledTimes(1);
    const firstKey = markResumable.mock.calls[0][0].idempotencyKey;

    await user.click(resume);
    await waitFor(() => expect(onAcknowledged).toHaveBeenCalledWith(acknowledgement("resumable"), "resume_later"));
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(markResumable).toHaveBeenCalledTimes(2);
    expect(markResumable.mock.calls[1][0]).toEqual({ acknowledgedProgressVersion: 2, idempotencyKey: firstKey });
  });

  it("never advertises completion when Finish now fails", async () => {
    const user = userEvent.setup();
    const finishSession = vi.fn(async () => { throw new Error("Finalization is still pending."); });
    const onAcknowledged = vi.fn();
    renderFlow({ finishSession, onAcknowledged });
    await user.click(screen.getByRole("button", { name: "Return to Babysteps" }));
    await user.click(screen.getByRole("button", { name: /Finish session now/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Finalization is still pending");
    expect(screen.getByText(/session remains active/i)).toBeInTheDocument();
    expect(onAcknowledged).not.toHaveBeenCalled();
  });

  it("intercepts browser history navigation and opens the protected exit UI", () => {
    renderFlow();
    fireEvent.popState(window);
    expect(screen.getByRole("dialog", { name: "Return to Babysteps?" })).toBeInTheDocument();
  });

  it("disables duplicate action taps while the protected request is processing", async () => {
    const user = userEvent.setup();
    let resolve!: (value: ReturnType<typeof acknowledgement>) => void;
    const markResumable = vi.fn(() => new Promise<ReturnType<typeof acknowledgement>>((done) => { resolve = done; }));
    renderFlow({ markResumable });
    await user.click(screen.getByRole("button", { name: "Return to Babysteps" }));
    const resume = screen.getByRole("button", { name: /Resume this session later/ });
    await user.click(resume);
    expect(resume).toBeDisabled();
    await user.click(resume);
    expect(markResumable).toHaveBeenCalledTimes(1);
    resolve(acknowledgement("resumable"));
  });
});
