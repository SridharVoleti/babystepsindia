import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { ParentModeGuard } from "@/components/account/mode-guard";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PD-004 ParentModeGuard component — AT-PD-004-23/25", () => {
  it("renders nothing", () => {
    const { container } = render(<ParentModeGuard modeGeneration={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("AT-PD-004-25: a bfcache-restore pageshow that reveals a stale generation forces a fresh login", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ modeGeneration: 9 }), { status: 200 }),
    ));
    const replace = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, replace }, writable: true });

    render(<ParentModeGuard modeGeneration={1} />);
    const event = new Event("pageshow");
    Object.defineProperty(event, "persisted", { value: true });
    window.dispatchEvent(event);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });

  it("a 403 mode-mismatch probe routes to /learner, not /login (learner-mode unlock must not bounce the current tab)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    const replace = vi.fn();
    Object.defineProperty(window, "location", { value: { ...window.location, replace }, writable: true });

    render(<ParentModeGuard modeGeneration={1} />);
    const event = new Event("pageshow");
    Object.defineProperty(event, "persisted", { value: true });
    window.dispatchEvent(event);

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/learner"));
  });

  it("does not fetch on an ordinary (non-persisted) pageshow", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ modeGeneration: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ParentModeGuard modeGeneration={1} />);
    const event = new Event("pageshow");
    Object.defineProperty(event, "persisted", { value: false });
    window.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
