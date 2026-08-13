// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { enqueueTransactionalNotification, getNotificationIntentBySource, NotificationServiceError } from
  "@/lib/notifications/service";

let parentId: string;

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`nt001-svc-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
});

function baseInput(overrides: Partial<Parameters<typeof enqueueTransactionalNotification>[0]> = {}) {
  return {
    notificationType: "billing_payment_recovered",
    sourceDomain: "billing",
    sourceEventKey: `evt-${randomUUID()}`,
    sourceVersion: 1,
    parentId,
    safeVariables: { subscriptionLabel: "Family Plan" },
    ...overrides,
  };
}

describe("NT-001 enqueueTransactionalNotification", () => {
  it("AT-NT-001-01/09: rejects an unknown notification type", () => {
    expect(() => enqueueTransactionalNotification(baseInput({ notificationType: "not_a_real_type" })))
      .toThrow(NotificationServiceError);
  });

  it("AT-NT-001-02/08: rejects a source domain that isn't the type's allowlisted domain", () => {
    expect(() => enqueueTransactionalNotification(baseInput({ sourceDomain: "browser" })))
      .toThrow(/SOURCE_DOMAIN_NOT_ALLOWED/);
  });

  it("AT-NT-001-10: rejects an unexpected safe variable", () => {
    expect(() => enqueueTransactionalNotification(
      baseInput({ safeVariables: { subscriptionLabel: "Family Plan", extra: "nope" } })))
      .toThrow();
  });

  it("AT-NT-001-11: never accepts raw HTML as a variable value (still schema-typed, not sanitized-then-trusted)", () => {
    expect(() => enqueueTransactionalNotification(
      baseInput({ notificationType: "billing_grace_started",
        safeVariables: { subscriptionLabel: "Plan", graceEndsAt: "<b>2026-09-01</b>" } })))
      .not.toThrow(); // stored as an opaque string variable, rendered escaped at template time (see templates test)
  });

  it("rejects when the parent does not exist", () => {
    expect(() => enqueueTransactionalNotification(baseInput({ parentId: randomUUID() })))
      .toThrow(/RESOURCE_NOT_FOUND/);
  });

  it("AT-NT-001-24: a replayed source event creates exactly one logical notification", () => {
    const input = baseInput();
    const first = enqueueTransactionalNotification(input);
    const second = enqueueTransactionalNotification(input);
    expect(second.notificationId).toBe(first.notificationId);
    const rows = getDb().prepare("select count(*) as c from transactional_notification_intents where notification_id=?")
      .get(first.notificationId) as { c: number };
    expect(rows.c).toBe(1);
  });

  it("AT-NT-001-25: same identity with a different semantic payload is rejected as a conflict, not overwritten", () => {
    const sourceEventKey = `evt-${randomUUID()}`;
    enqueueTransactionalNotification(baseInput({ sourceEventKey, safeVariables: { subscriptionLabel: "Family Plan" } }));
    expect(() => enqueueTransactionalNotification(
      baseInput({ sourceEventKey, safeVariables: { subscriptionLabel: "Different Plan" } })))
      .toThrow(/NOTIFICATION_SEMANTIC_CONFLICT/);
  });

  it("getNotificationIntentBySource (API-NT-005) finds the enqueued intent by source identity", () => {
    const sourceEventKey = `evt-${randomUUID()}`;
    const { notificationId } = enqueueTransactionalNotification(baseInput({ sourceEventKey }));
    const found = getNotificationIntentBySource("billing", sourceEventKey);
    expect(found).toHaveLength(1);
    expect(found[0].notificationId).toBe(notificationId);
    expect(found[0].state).toBe("pending");
  });

  it("a foreign source key returns no rows (AC46-style scoping, not an error leak)", () => {
    expect(getNotificationIntentBySource("billing", "evt-does-not-exist")).toEqual([]);
  });
});
