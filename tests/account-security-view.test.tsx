import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AccountSecurityView } from "@/components/account/account-security-view";
import type { SecurityView } from "@/lib/db/account-security-repo";

afterEach(() => {
  vi.unstubAllGlobals();
});

const noPending: SecurityView = { email: "parent@example.com", pendingEmailChange: null };
const withPending: SecurityView = {
  email: "parent@example.com",
  pendingEmailChange: { newEmail: "new@example.com", expiresAt: "2026-08-05T00:00:00.000Z" },
};

describe("AccountSecurityView", () => {
  it("shows the current email and no pending-change card when nothing is pending", () => {
    render(<AccountSecurityView initialView={noPending} />);
    expect(screen.getByText("parent@example.com")).toBeInTheDocument();
    expect(screen.queryByText(/pending/i)).not.toBeInTheDocument();
  });

  it("shows the pending email, expiry, and Resend/Cancel controls", () => {
    render(<AccountSecurityView initialView={withPending} />);
    expect(screen.getByText("new@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resend/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("cancelling removes the pending card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }),
    );
    const user = userEvent.setup();
    render(<AccountSecurityView initialView={withPending} />);

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByText("new@example.com")).not.toBeInTheDocument());
  });

  it("resending shows the refreshed dev-mode verification link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          expiresAt: "2026-08-06T00:00:00.000Z",
          verificationUrl: "http://localhost/auth/email-change/callback?token=fresh",
        }),
      }),
    );
    const user = userEvent.setup();
    render(<AccountSecurityView initialView={withPending} />);

    await user.click(screen.getByRole("button", { name: /resend/i }));

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /email-change\/callback/i })).toHaveAttribute(
        "href",
        "http://localhost/auth/email-change/callback?token=fresh",
      ),
    );
  });
});
