import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetryRunButton } from "@/components/analytics/retry-run-button";

afterEach(() => vi.unstubAllGlobals());

describe("RetryRunButton", () => {
  it("AD-001: sends no password — sensitive reauth is a live receipt, not per-call input", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "REAUTHENTICATION_REQUIRED" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<RetryRunButton activityDate="2026-08-04" />);
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry).toBeEnabled();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();

    await user.click(retry);

    expect(fetchMock).toHaveBeenCalledWith("/v1/admin/analytics/runs/2026-08-04/retry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("REAUTHENTICATION_REQUIRED");
  });
});
