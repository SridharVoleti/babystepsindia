// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearningReminderPreference } from "@/components/account/learning-reminder-preference";

afterEach(() => vi.unstubAllGlobals());

describe("EG-006 parent notification settings", () => {
  it("AT-EG-006-45..47 is parent-focused, deliberate on desktop/mobile, and separates transactional mail", () => {
    const { container } = render(<LearningReminderPreference initialEnabled initialVersion={1} />);
    expect(screen.getByRole("switch", { name: "Learning reminder emails" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/email you—not the learner/i)).toBeInTheDocument();
    expect(screen.getByText(/separate from billing, security, and account messages/i)).toBeInTheDocument();
    expect(screen.getByRole("switch")).toHaveClass("min-h-[44px]");
    expect(container.querySelector(".sm\\:flex-row")).toBeTruthy();
    expect(container.textContent).not.toMatch(/learner email|learner phone|sms|whatsapp|push token/i);
  });

  it("AT-EG-006-33/46 updates through the parent-only versioned endpoint", async () => {
    // NT-003: the PATCH response is now the full NotificationPreferences contract.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({
      preferenceVersion: 2, categories: [{ key: "learning_reminders", enabled: false }] }) });
    vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("crypto", { randomUUID: () => "preference-1" });
    render(<LearningReminderPreference initialEnabled initialVersion={1} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(fetchMock).toHaveBeenCalledWith("/v1/parent/notification-preferences", expect.objectContaining({
      method: "PATCH", credentials: "same-origin", cache: "no-store",
      body: JSON.stringify({ learningReminderEmailEnabled: false, expectedVersion: 1,
        idempotencyKey: "preference-1" }) }));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("status")).toHaveTextContent("Preference saved.");
  });
});
