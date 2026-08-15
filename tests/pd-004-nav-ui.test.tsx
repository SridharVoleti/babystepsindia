// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/account/attention" }));

import { ParentNav } from "@/components/account/parent-nav";

// PD4-G10 AT-PD-004-01..48 traceability. Cases marked "manual" were verified
// by hand in a real browser during the original PD-004 build (see README's
// "Parent dashboard, learner detail, attention center and navigation shell"
// section) — this app has no automated E2E/browser framework, only vitest +
// @testing-library/react, so purely visual/layout/interaction cases stay
// hybrid rather than gaining a brittle DOM-measurement test.
//
// 01 manual (login renders shell)               17 automated (au-002 passkey unlock flow)
// 02-06 automated (this file — nav destinations) 18 manual (learner home has no ParentNav)
// 07 tests/pd-004-shell.test.ts                  19 automated (route-actions.ts mode gating)
// 08 tests/pd-004-shell.test.ts + route test      20-22 automated (authorization-modes.test.ts,
// 09 manual (no animation/reward in nav markup)        au-002.acceptance.test.ts exit flow)
// 10 tests/pd-004-shell.test.ts                  23 tests/pd-004-mode-guard(-ui).test.ts(x)
// 11-13 manual (post-login redirect UX)          24 automated (requireLearnerMode redirects on
// 14 automated (au-002: parent routes need no          stale mode — authorization-modes.test.ts)
//    learner unlock)                             25 tests/pd-004-mode-guard(-ui).test.ts(x)
// 15 automated (parent-attention.test.ts pure-    26 automated (requireParentManagement redirect)
//    read assertions — nav never mutates)         27 automated (requireLearnerMode redirect)
// 16 manual (Open learner is its own CTA, not     28 tests/pd-004-shell.test.ts + mode-guard tests
//    a nav item — see PD-002/PD-001 UI)           29-30 tests/pd-004-mode-guard.test.ts
//                                                 31 automated (Next.js App Router history — no
//                                                    server mutation on Back/Forward, covered by
//                                                    every route's own pure-read tests)
// 32 this file (no per-app nav destinations)      41 automated (aria-current, not color-only)
// 33 manual (visual parent/learner distinction)   42 tests/pd-004-shell.test.ts (badge aria-label)
// 34 automated (PD-002 stays parent_management —  43 manual (keyboard focus order)
//    tests/pd-002-learner-detail.test.ts)         44 manual (320px layout)
// 35 automated (no interval/poll in ParentNav/     45 automated (no <video>/<marquee>/blink in nav
//    mode-guard — event-driven only)                  or badge markup)
// 36 manual (offline chrome-only rendering)        46 automated (mode-guard sessionStorage/
// 37-40 this file (destinations, touch targets)         localStorage usage — no named nav-history
//                                                        key, only the shell ETag cache)
//                                                  47 tests/pd-004-shell.test.ts (capabilityHints
//                                                        non-authoritative, no new auth table)
//                                                  48 automated (every destination route calls
//                                                        requireEndUserAuthorization/
//                                                        requireParentManagement independently —
//                                                        au-001/au-002 acceptance suites)

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
