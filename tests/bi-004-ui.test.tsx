import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AutoRenewControl } from "@/components/billing/auto-renew-control";

const baseProps = { subscriptionId: "sub-1", currentPeriodEnd: "2026-09-10T10:00:00.000Z",
  productName: "Math Monthly", learnerName: "Asha", expectedAmount: 29900, currency: "INR",
  expectedVersion: 2 };

afterEach(() => vi.unstubAllGlobals());

describe("BI-004 parent cancellation UI", () => {
  it("AT-BI-004-03/04/18 explains period-end access and progress with Cancel—not Delete or Pause", () => {
    render(<AutoRenewControl {...baseProps} initialEnabled={true} initialCancelAtPeriodEnd={false}
      initialCancellationEffectiveAt={null} />);
    expect(screen.getByRole("button", { name: "Cancel subscription" })).toBeVisible();
    expect(screen.getByText(/continues through the paid period/i)).toBeVisible();
    expect(screen.getByText(/does not delete progress or end access immediately/i)).toBeVisible();
    expect(screen.queryByText(/pause subscription/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });

  it("AT-BI-004-18/20/23 shows learner/product/end date and keeps cancellation pending for hosted setup", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202, json: async () => ({
      providerHostedSetupRequired: true, setupUrl: "/provider/setup", setupExpiresAt: "2026-08-20T10:15:00.000Z",
      version: 3,
    }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutoRenewControl {...baseProps} initialEnabled={false} initialCancelAtPeriodEnd={true}
      initialCancellationEffectiveAt="2026-09-10T10:00:00.000Z" />);
    expect(screen.getByText(/Subscription ends on/i)).toBeVisible();
    expect(screen.getByText(/Progress for Asha is preserved/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Resume auto-renewal" }));
    await waitFor(() => expect(screen.getByRole("link", { name: /Continue with payment provider/i })).toBeVisible());
    expect(screen.getByText(/remains scheduled to end until Babysteps receives provider confirmation/i)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith("/v1/parent/subscriptions/sub-1/resume-auto-renew", expect.any(Object));
  });

  it("AT-BI-004-30 prominently confirms the exact late-reversal charge without promising a duplicate reminder", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      providerHostedSetupRequired: false, expectedAmount: 29900, currency: "INR",
      nextChargeAt: "2026-09-10T10:00:00.000Z", lateConfirmationRequired: true, version: 3,
    }) }));
    render(<AutoRenewControl {...baseProps} initialEnabled={false} initialCancelAtPeriodEnd={true}
      initialCancellationEffectiveAt="2026-09-10T10:00:00.000Z" />);
    fireEvent.click(screen.getByRole("button", { name: "Resume auto-renewal" }));
    await waitFor(() => expect(screen.getByText(/The next charge is ₹299\.00/i)).toBeVisible());
    expect(screen.getByText(/replaces the already-passed seven-day reminder/i)).toBeVisible();
  });
});
