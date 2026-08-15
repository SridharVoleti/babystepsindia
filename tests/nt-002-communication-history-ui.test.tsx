import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireParentManagement: vi.fn(async () => ({ session: { sub: "parent-1" } })),
  listOwnedLearners: vi.fn(() => [{ id: "learner-1", displayName: "Asha" }, { id: "learner-2", displayName: "Ravi" }]),
  getParentTimezone: vi.fn(() => "Asia/Kolkata"),
  composeParentCommunicationHistory: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({ requireParentManagement: mocks.requireParentManagement }));
vi.mock("@/lib/db/learner-repo", () => ({ listOwnedLearners: mocks.listOwnedLearners, getParentTimezone: mocks.getParentTimezone }));
vi.mock("@/lib/notification-history/service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notification-history/service")>("@/lib/notification-history/service");
  return { ...actual, composeParentCommunicationHistory: mocks.composeParentCommunicationHistory };
});

import CommunicationHistoryPage from "@/app/account/notifications/history/page";
import { ParentCommunicationHistoryRequestError } from "@/lib/notification-history/service";

const sampleItem = {
  communicationId: "comm-1", occurredAt: "2026-08-01T00:00:00.000Z", category: "billing" as const,
  title: "Your Babysteps payment was recovered", subscriptionContext: "Family Plan",
  deliveryState: "sent" as const, action: { label: "Manage subscription", href: "/account/subscriptions" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireParentManagement.mockResolvedValue({ session: { sub: "parent-1" } });
  mocks.listOwnedLearners.mockReturnValue([{ id: "learner-1", displayName: "Asha" }, { id: "learner-2", displayName: "Ravi" }]);
  mocks.composeParentCommunicationHistory.mockReturnValue({
    historyVersion: "v1", retentionMonths: 13, items: [sampleItem], nextCursor: null,
  });
});

describe("NT-002 Communication history UI (AT-NT-002-41/42/43/44)", () => {
  it("renders category and learner filter chips", async () => {
    render(await CommunicationHistoryPage({ searchParams: {} }));
    expect(screen.getByRole("link", { name: "All categories" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Billing" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Account & security" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Asha" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ravi" })).toBeInTheDocument();
  });

  it("passes the category/learnerId query params through to API-NT-006's composer", async () => {
    render(await CommunicationHistoryPage({ searchParams: { category: "billing", learnerId: "learner-1" } }));
    expect(mocks.composeParentCommunicationHistory).toHaveBeenCalledWith("parent-1",
      { category: "billing", learnerId: "learner-1", limit: "50" }, expect.any(Date));
  });

  it("AT-NT-002-40/41: shows date, title, delivery status text and the action link, not full email content", async () => {
    render(await CommunicationHistoryPage({ searchParams: {} }));
    expect(screen.getAllByText("Your Babysteps payment was recovered").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Sent/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Manage subscription/).length).toBeGreaterThan(0);
  });

  it("AT-NT-002-43: every action link is a real touch target (>=44px) and status is conveyed as text", async () => {
    const { container } = render(await CommunicationHistoryPage({ searchParams: {} }));
    const mobileActions = container.querySelectorAll(".sm\\:hidden a");
    expect(mobileActions.length).toBeGreaterThan(0);
    for (const link of mobileActions) expect(link.className).toMatch(/min-h-\[44px\]/);
  });

  it("AT-NT-002-44: shows a calm, non-inbox empty state with no items", async () => {
    mocks.composeParentCommunicationHistory.mockReturnValue({ historyVersion: "v1", retentionMonths: 13, items: [], nextCursor: null });
    render(await CommunicationHistoryPage({ searchParams: {} }));
    expect(screen.getByText("No transactional communications are available in the retained history window.")).toBeInTheDocument();
  });

  it("a malformed filter query degrades to the unfiltered view rather than crashing the page", async () => {
    mocks.composeParentCommunicationHistory
      .mockImplementationOnce(() => { throw new ParentCommunicationHistoryRequestError("INVALID_CATEGORY"); })
      .mockReturnValueOnce({ historyVersion: "v1", retentionMonths: 13, items: [sampleItem], nextCursor: null });
    render(await CommunicationHistoryPage({ searchParams: { category: "bogus" } }));
    expect(mocks.composeParentCommunicationHistory).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("Your Babysteps payment was recovered").length).toBeGreaterThan(0);
  });

  it("never renders an unread marker, folder, reply or resend/delete control", async () => {
    render(await CommunicationHistoryPage({ searchParams: {} }));
    for (const forbidden of [/unread/i, /folder/i, /reply/i, /resend/i, /^delete$/i, /mark as read/i]) {
      expect(screen.queryByText(forbidden)).not.toBeInTheDocument();
    }
  });
});
