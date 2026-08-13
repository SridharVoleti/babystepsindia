import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireEndUserAuthorization: vi.fn(), requireInternalService: vi.fn(),
  withLockedEndUserMutation: vi.fn(), getParentNotificationPreference: vi.fn(),
  updateParentNotificationPreference: vi.fn(), evaluateLearningReminders: vi.fn(),
  sendLearningReminder: vi.fn(), reconcileLearningReminderDeliveries: vi.fn() }));

vi.mock("@/lib/authorization/api-guard", () => ({ requireEndUserAuthorization: mocks.requireEndUserAuthorization }));
vi.mock("@/lib/auth/internal-service-guard", () => ({ requireInternalService: mocks.requireInternalService }));
vi.mock("@/lib/authorization/locked-mutation", () => ({ withLockedEndUserMutation: mocks.withLockedEndUserMutation }));
vi.mock("@/lib/learning-reminders/service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/learning-reminders/service")>(),
  getParentNotificationPreference: mocks.getParentNotificationPreference,
  updateParentNotificationPreference: mocks.updateParentNotificationPreference,
  evaluateLearningReminders: mocks.evaluateLearningReminders,
  sendLearningReminder: mocks.sendLearningReminder,
  reconcileLearningReminderDeliveries: mocks.reconcileLearningReminderDeliveries,
}));

import { GET as preferenceGet, PATCH as preferencePatch } from
  "@/app/v1/parent/notification-preferences/route";
import { POST as evaluatePost } from "@/app/v1/internal/learning-reminders/evaluate/route";
import { POST as sendPost } from "@/app/v1/internal/learning-reminders/send/route";
import { POST as reconcilePost } from "@/app/v1/internal/learning-reminders/reconcile-delivery/route";

function request(body: unknown, method = "POST") {
  return new Request("https://example.test", { method, headers: { "content-type": "application/json" },
    body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEndUserAuthorization.mockResolvedValue({ ok: true, parent: { session: { sub: "parent-1" } },
    authorization: { mode: "parent_management", parentUserId: "parent-1" } });
  mocks.requireInternalService.mockResolvedValue({ ok: true, principal: { id: "service-1" } });
  mocks.withLockedEndUserMutation.mockImplementation(({ mutate }) => mutate());
  mocks.getParentNotificationPreference.mockReturnValue({ learningReminderEmailEnabled: true, version: 1 });
  mocks.updateParentNotificationPreference.mockReturnValue({ learningReminderEmailEnabled: false, version: 2 });
  mocks.evaluateLearningReminders.mockReturnValue({ parentBatches: ["batch-1"], batchCount: 1,
    itemCount: 2, suppressedCount: 0, nextCursor: null });
  mocks.sendLearningReminder.mockReturnValue({ status: "sent", batchId: "batch-1", sent: true, itemCount: 2 });
  mocks.reconcileLearningReminderDeliveries.mockReturnValue({ delivered: 1, retried: 0,
    failed: 0, unchanged: 0, nextCursor: null });
});

describe("EG-006 routes", () => {
  it("API-EG-024 reads and updates only the current parent preference", async () => {
    const read = await preferenceGet(new Request("https://example.test/v1/parent/notification-preferences"));
    expect(mocks.requireEndUserAuthorization).toHaveBeenCalledWith(expect.any(Request),
      "parent.notification_preferences.read");
    expect(read.headers.get("Cache-Control")).toBe("private, no-store");
    await preferencePatch(request({ learningReminderEmailEnabled: false, expectedVersion: 1,
      idempotencyKey: "pref-1" }, "PATCH"));
    expect(mocks.withLockedEndUserMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: "parent.notification_preferences.update", resource: { parentUserId: "parent-1" } }));
    expect(mocks.updateParentNotificationPreference).toHaveBeenCalledWith("parent-1", expect.objectContaining({
      learningReminderEmailEnabled: false, expectedVersion: 1, idempotencyKey: "pref-1" }));
  });

  it("API-EG-025 requires the exact scheduler and bounded stage input", async () => {
    await evaluatePost(request({ reminderStage: "mid_window", cursor: null, limit: 20,
      runIdempotencyKey: "run-1" }));
    expect(mocks.requireInternalService).toHaveBeenCalledWith(expect.any(Request), "learning-reminder-scheduler");
    expect(mocks.evaluateLearningReminders).toHaveBeenCalledWith(expect.objectContaining({
      reminderStage: "mid_window", limit: 20, principalId: "service-1" }));
  });

  it("API-EG-026 requires the distinct sender and never accepts recipient identity", async () => {
    await sendPost(request({ parentReminderBatchId: "batch-1", expectedBatchVersion: 1,
      idempotencyKey: "send-1" }));
    expect(mocks.requireInternalService).toHaveBeenCalledWith(expect.any(Request), "learning-reminder-sender");
    expect(mocks.sendLearningReminder).toHaveBeenCalledWith({ parentReminderBatchId: "batch-1",
      expectedBatchVersion: 1, idempotencyKey: "send-1" });
    const denied = await sendPost(request({ parentReminderBatchId: "batch-1", expectedBatchVersion: 1,
      idempotencyKey: "send-2", learnerEmail: "learner@example.com" }));
    expect(denied.status).toBe(400);
  });

  it("API-EG-027 uses its own reconciliation principal and bounded cursor", async () => {
    await reconcilePost(request({ batchId: "batch-1", cursor: null, limit: 20,
      runIdempotencyKey: "reconcile-1" }));
    expect(mocks.requireInternalService).toHaveBeenCalledWith(expect.any(Request),
      "learning-reminder-reconciliation");
    expect(mocks.reconcileLearningReminderDeliveries).toHaveBeenCalledWith(expect.objectContaining({
      batchId: "batch-1", limit: 20, principalId: "service-1" }));
  });
});
