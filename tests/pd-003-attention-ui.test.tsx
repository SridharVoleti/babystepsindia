import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireParentManagement: vi.fn(async () => ({ session: { sub: "parent-1" } })),
  listOwnedLearners: vi.fn(() => [{ id: "learner-1", displayName: "Asha" }, { id: "learner-2", displayName: "Ravi" }]),
  getParentTimezone: vi.fn(() => "Asia/Kolkata"),
  composeParentAttentionList: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({ requireParentManagement: mocks.requireParentManagement }));
vi.mock("@/lib/db/learner-repo", () => ({ listOwnedLearners: mocks.listOwnedLearners, getParentTimezone: mocks.getParentTimezone }));
vi.mock("@/lib/parent-attention/service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/parent-attention/service")>("@/lib/parent-attention/service");
  return { ...actual, composeParentAttentionList: mocks.composeParentAttentionList };
});

import AttentionPage from "@/app/account/attention/page";
import { ParentAttentionRequestError } from "@/lib/parent-attention/service";

const sampleItem = {
  sourceKey: "billing:sub-1:payment", category: "billing" as const, severity: "action_required" as const,
  learnerId: "learner-1", learnerName: "Asha", appId: null, appName: null, subscriptionId: "sub-1",
  title: "Payment attention needed", message: "Update payment details.",
  route: { href: "/account/subscriptions", label: "Review billing" }, effectiveAt: null, sourceVersion: "1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireParentManagement.mockResolvedValue({ session: { sub: "parent-1" } });
  mocks.listOwnedLearners.mockReturnValue([{ id: "learner-1", displayName: "Asha" }, { id: "learner-2", displayName: "Ravi" }]);
  mocks.composeParentAttentionList.mockReturnValue({
    composedAt: "t", version: "v1", nextRecheckAt: null,
    items: [sampleItem], partialErrors: [], summary: { actionRequiredCount: 1, attentionCount: 0, infoCount: 0 }, nextCursor: null,
  });
});

describe("PD-003 attention center UI filters (PD3-G08, AT-PD-003-35/45/46)", () => {
  it("renders severity, category and learner filter chips", async () => {
    render(await AttentionPage({ searchParams: {} }));
    expect(screen.getByRole("link", { name: "All statuses" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Action needed" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All categories" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Billing" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Asha" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ravi" })).toBeInTheDocument();
  });

  it("passes the section's severity/category/learnerId query params through to the API-PD-004 composer", async () => {
    render(await AttentionPage({ searchParams: { severity: "attention", category: "billing", learnerId: "learner-1" } }));
    expect(mocks.composeParentAttentionList).toHaveBeenCalledWith("parent-1",
      { severity: "attention", category: "billing", learnerId: "learner-1", limit: "50" }, expect.any(Date));
  });

  it("every filter chip link is a real touch target (>=44px)", async () => {
    const { container } = render(await AttentionPage({ searchParams: {} }));
    const filterSection = container.querySelector('[aria-label="Filter attention items"]');
    const chips = filterSection!.querySelectorAll("a");
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) expect(chip.className).toMatch(/min-h-\[44px\]/);
  });

  it("shows a distinct empty message when a filter matches nothing, vs the true zero state", async () => {
    mocks.composeParentAttentionList.mockReturnValue({
      composedAt: "t", version: "v1", nextRecheckAt: null, items: [], partialErrors: [],
      summary: { actionRequiredCount: 0, attentionCount: 0, infoCount: 0 }, nextCursor: null,
    });
    render(await AttentionPage({ searchParams: { category: "billing" } }));
    expect(screen.getByText("No items match this filter.")).toBeInTheDocument();
  });

  it("AT-PD-003-37: shows the calm zero state with no filters and no items", async () => {
    mocks.composeParentAttentionList.mockReturnValue({
      composedAt: "t", version: "v1", nextRecheckAt: null, items: [], partialErrors: [],
      summary: { actionRequiredCount: 0, attentionCount: 0, infoCount: 0 }, nextCursor: null,
    });
    render(await AttentionPage({ searchParams: {} }));
    expect(screen.getByText("Nothing needs your attention right now.")).toBeInTheDocument();
  });

  it("PD3-G09: a malformed filter query degrades to the unfiltered view rather than crashing the page", async () => {
    mocks.composeParentAttentionList
      .mockImplementationOnce(() => { throw new ParentAttentionRequestError("INVALID_SEVERITY"); })
      .mockReturnValueOnce({ composedAt: "t", version: "v1", nextRecheckAt: null, items: [sampleItem], partialErrors: [],
        summary: { actionRequiredCount: 1, attentionCount: 0, infoCount: 0 }, nextCursor: null });
    render(await AttentionPage({ searchParams: { severity: "bogus" } }));
    expect(mocks.composeParentAttentionList).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Payment attention needed")).toBeInTheDocument();
  });
});
