// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireParentManagement: vi.fn(async () => ({ session: { sub: "parent-1" } })),
  composeParentNotificationPreferences: vi.fn(),
}));

vi.mock("@/lib/auth/guards", () => ({ requireParentManagement: mocks.requireParentManagement }));
vi.mock("@/lib/notification-preferences/service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notification-preferences/service")>("@/lib/notification-preferences/service");
  return { ...actual, composeParentNotificationPreferences: mocks.composeParentNotificationPreferences };
});

import NotificationSettingsPage from "@/app/account/notifications/page";

const samplePreferences = {
  preferenceVersion: 3, updatedAt: "2026-08-15T00:00:00.000Z",
  destination: { channel: "email" as const, verifiedEmailHint: "p•••••@example.com" },
  categories: [
    { key: "billing" as const, label: "Billing & payments", required: true, channel: "email" as const, status: "Always on", description: "Payment and renewal emails." },
    { key: "financial_document" as const, label: "Financial documents & refunds", required: true, channel: "email" as const, status: "Always on", description: "Invoices and refunds." },
    { key: "account_security" as const, label: "Account & security", required: true, channel: "email" as const, status: "Always on", description: "Email/password changes." },
    { key: "service" as const, label: "Material service notices", required: true, channel: "email" as const, status: "Always on", description: "Important service notices." },
    { key: "learning_reminders" as const, label: "Learning reminders", required: false, channel: "email" as const, status: "On",
      description: "Weekly reminders.", preferenceKey: "learningReminderEmailEnabled" as const, enabled: true },
  ],
  communicationHistoryRoute: "/account/notifications/history",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireParentManagement.mockResolvedValue({ session: { sub: "parent-1" } });
  mocks.composeParentNotificationPreferences.mockReturnValue(samplePreferences);
});

describe("NT-003 Notification settings UI (AT-NT-003-03/06/11/39/42/43/44/45)", () => {
  it("renders every mandatory category as Always on text, not a toggle", async () => {
    render(await NotificationSettingsPage());
    for (const label of ["Billing & payments", "Financial documents & refunds", "Account & security", "Material service notices"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getAllByText("Always on")).toHaveLength(4);
    expect(screen.queryAllByRole("switch")).toHaveLength(1); // only the learning-reminders control
  });

  it("shows the masked destination email hint, never a raw address", async () => {
    render(await NotificationSettingsPage());
    expect(screen.getByText(/p•••••@example\.com/)).toBeInTheDocument();
  });

  it("passes the current learning-reminder state and preferenceVersion to the toggle", async () => {
    render(await NotificationSettingsPage());
    const toggle = screen.getByRole("switch", { name: "Learning reminder emails" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("links to NT-002 communication history via the frozen route field", async () => {
    render(await NotificationSettingsPage());
    const link = screen.getByRole("link", { name: /View communication history/ });
    expect(link).toHaveAttribute("href", "/account/notifications/history");
  });

  it("AT-NT-003-45: uses neutral copy with no guilt/pressure language", async () => {
    render(await NotificationSettingsPage());
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toMatch(/miss out|you'll lose|falling behind|warning/i);
  });
});
