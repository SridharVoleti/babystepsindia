// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/account/attention" }));

import { ParentNav } from "@/components/account/parent-nav";

describe("PD-004 parent navigation shell", () => {
  it("renders all five primary destinations with the badge count on Attention only", () => {
    render(<ParentNav attentionCount={3} onSignOut={() => {}} />);
    const attentionLinks = screen.getAllByRole("link", { name: /Attention/ });
    expect(attentionLinks.length).toBeGreaterThan(0);
    for (const link of attentionLinks) expect(link.textContent).toMatch(/3/);
    expect(screen.getAllByRole("link", { name: /^Home/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /^Learners/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /^Billing/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: /^Account/ }).length).toBeGreaterThan(0);
  });

  it("marks the current route active via aria-current", () => {
    render(<ParentNav attentionCount={0} onSignOut={() => {}} />);
    const current = screen.getAllByRole("link", { current: "page" });
    expect(current.length).toBeGreaterThan(0);
    for (const link of current) expect(link).toHaveAttribute("href", "/account/attention");
  });

  it("hides the badge entirely when there is nothing to show", () => {
    render(<ParentNav attentionCount={0} onSignOut={() => {}} />);
    expect(screen.queryByLabelText(/item.*need attention/i)).not.toBeInTheDocument();
  });

  it("exposes a Log out control reachable on both desktop and mobile", () => {
    render(<ParentNav attentionCount={0} onSignOut={() => {}} />);
    expect(screen.getAllByRole("button", { name: /log out/i }).length).toBeGreaterThan(0);
  });

  it("gives every nav link a >=44px touch target", () => {
    const { container } = render(<ParentNav attentionCount={1} onSignOut={() => {}} />);
    const links = container.querySelectorAll("a");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.className).toMatch(/min-h-\[44px\]/);
  });
});
