import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireEndUserAuthorization: vi.fn(),
  withLockedEndUserMutation: vi.fn(),
  composeParentNotificationPreferences: vi.fn(),
  applyParentNotificationPreferenceChange: vi.fn(),
}));

vi.mock("@/lib/authorization/api-guard", () => ({ requireEndUserAuthorization: mocks.requireEndUserAuthorization }));
vi.mock("@/lib/authorization/locked-mutation", () => ({ withLockedEndUserMutation: mocks.withLockedEndUserMutation }));
vi.mock("@/lib/notification-preferences/service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notification-preferences/service")>("@/lib/notification-preferences/service");
  return { ...actual,
    composeParentNotificationPreferences: mocks.composeParentNotificationPreferences,
    applyParentNotificationPreferenceChange: mocks.applyParentNotificationPreferenceChange,
  };
});

import { GET as preferencesGet, PATCH as preferencesPatch } from "@/app/v1/parent/notification-preferences/route";
import { LearningReminderError } from "@/lib/learning-reminders/service";

const guardOk = { ok: true, parent: { session: { sub: "parent-1" } }, authorization: { mode: "parent_management", parentUserId: "parent-1" } };

const samplePreferences = {
  preferenceVersion: 2, updatedAt: "2026-08-15T00:00:00.000Z",
  destination: { channel: "email", verifiedEmailHint: "p•••••@example.com" },
  categories: [
    { key: "billing", label: "Billing & payments", required: true, channel: "email", status: "Always on", description: "d" },
    { key: "learning_reminders", label: "Learning reminders", required: false, channel: "email", status: "On",
      description: "d", preferenceKey: "learningReminderEmailEnabled", enabled: true },
  ],
  communicationHistoryRoute: "/account/notifications/history",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue(guardOk);
  mocks.withLockedEndUserMutation.mockImplementation(({ mutate }) => mutate());
});

describe("GET /v1/parent/notification-preferences — API-NT-008", () => {
  it("AT-NT-003-02: passes through guard denial (e.g. learner_mode)", async () => {
    const denied = { ok: false, response: new Response(null, { status: 403 }) };
    mocks.requireEndUserAuthorization.mockResolvedValue(denied);
    const response = await preferencesGet(new Request("http://x"));
    expect(response).toBe(denied.response);
  });

  it("returns the frozen NotificationPreferences shape with mandatory categories and the one optional preference", async () => {
    mocks.composeParentNotificationPreferences.mockReturnValue(samplePreferences);
    const response = await preferencesGet(new Request("http://x"));
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.anything(), "parent.notification_preferences.read");
    expect(mocks.composeParentNotificationPreferences).toHaveBeenCalledWith("parent-1");
    const body = await response.json();
    expect(body).toEqual(samplePreferences);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("PATCH /v1/parent/notification-preferences — API-NT-009", () => {
  function patchRequest(body: unknown) {
    return new Request("http://x", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  it("AT-NT-003-10: rejects an unsupported/mandatory-category field before it ever reaches the composer", async () => {
    const response = await preferencesPatch(patchRequest({ billing: false, expectedVersion: 1, idempotencyKey: "k-1" }));
    expect(response.status).toBe(400);
    expect(mocks.applyParentNotificationPreferenceChange).not.toHaveBeenCalled();
  });

  it("applies the change through the one canonical composer, not the raw EG-006 function", async () => {
    mocks.applyParentNotificationPreferenceChange.mockReturnValue(samplePreferences);
    const response = await preferencesPatch(patchRequest({ learningReminderEmailEnabled: true, expectedVersion: 1, idempotencyKey: "k-1" }));
    expect(mocks.applyParentNotificationPreferenceChange).toHaveBeenCalledWith("parent-1",
      { learningReminderEmailEnabled: true, expectedVersion: 1, idempotencyKey: "k-1" });
    const body = await response.json();
    expect(body).toEqual(samplePreferences);
  });

  it("AT-NT-003-37: maps a version conflict to 409", async () => {
    mocks.applyParentNotificationPreferenceChange.mockImplementation(() => { throw new LearningReminderError("LEARNING_REMINDER_VERSION_CONFLICT"); });
    const response = await preferencesPatch(patchRequest({ learningReminderEmailEnabled: true, expectedVersion: 1, idempotencyKey: "k-1" }));
    expect(response.status).toBe(409);
  });

  it("AT-NT-003-39: maps an idempotency-key payload conflict to 409", async () => {
    mocks.applyParentNotificationPreferenceChange.mockImplementation(() => { throw new LearningReminderError("LEARNING_REMINDER_IDEMPOTENCY_CONFLICT"); });
    const response = await preferencesPatch(patchRequest({ learningReminderEmailEnabled: true, expectedVersion: 1, idempotencyKey: "k-1" }));
    expect(response.status).toBe(409);
  });
});
