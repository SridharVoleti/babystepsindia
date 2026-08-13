// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getNotificationDeliveryHealth, purgeExpiredNotificationMetadata } from "@/lib/notifications/retention";
import { enqueueTransactionalNotification, runNotificationDeliverySweep } from "@/lib/notifications/service";

let parentId: string;

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`nt001-ret-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
});

function enqueueAt(createdAt: string) {
  const { notificationId } = enqueueTransactionalNotification({
    notificationType: "billing_payment_recovered", sourceDomain: "billing",
    sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, parentId,
    safeVariables: { subscriptionLabel: "Family Plan" },
  }, new Date(createdAt));
  // Backdate the row directly — enqueue always stamps "now" at insert time,
  // and this test needs a genuinely 14-month-old row.
  getDb().prepare("update transactional_notification_intents set created_at=?,updated_at=? where notification_id=?")
    .run(createdAt, createdAt, notificationId);
  return notificationId;
}

describe("NT-001 purgeExpiredNotificationMetadata (AT-NT-001-42/43/44)", () => {
  it("AT-NT-001-43: purges intents older than the 13-month default", () => {
    const oldId = enqueueAt("2025-01-01T00:00:00.000Z");
    const recentId = enqueueAt("2026-08-01T00:00:00.000Z");
    const result = purgeExpiredNotificationMetadata(new Date("2026-08-13T00:00:00.000Z"));
    expect(result.intentsPurged).toBe(1);
    const remaining = getDb().prepare("select notification_id from transactional_notification_intents").all() as
      { notification_id: string }[];
    expect(remaining.map((r) => r.notification_id)).toEqual([recentId]);
    expect(remaining.map((r) => r.notification_id)).not.toContain(oldId);
  });

  it("AT-NT-001-42: cleanup removes NO permanent full body — delivery rows cascade-delete with their intent", () => {
    const oldId = enqueueAt("2025-01-01T00:00:00.000Z");
    runNotificationDeliverySweep({ now: new Date("2025-01-01T00:00:00.000Z") });
    expect((getDb().prepare("select count(*) n from transactional_notification_deliveries where notification_id=?")
      .get(oldId) as { n: number }).n).toBeGreaterThan(0);
    purgeExpiredNotificationMetadata(new Date("2026-08-13T00:00:00.000Z"));
    expect((getDb().prepare("select count(*) n from transactional_notification_deliveries where notification_id=?")
      .get(oldId) as { n: number }).n).toBe(0);
  });

  it("AT-NT-001-44: cleanup never touches source-domain tables (billing/subscriptions untouched)", () => {
    enqueueAt("2025-01-01T00:00:00.000Z");
    const before = getDb().prepare("select count(*) n from subscriptions").get() as { n: number };
    purgeExpiredNotificationMetadata(new Date("2026-08-13T00:00:00.000Z"));
    const after = getDb().prepare("select count(*) n from subscriptions").get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});

describe("NT-001 getNotificationDeliveryHealth (AT-NT-001-48)", () => {
  it("reports zero pending/no alerts when the queue is empty", () => {
    const health = getNotificationDeliveryHealth(new Date("2026-08-13T00:00:00.000Z"));
    expect(health).toMatchObject({ pendingCount: 0, oldestPendingAgeMs: null, queueAgeAlert: false,
      failureRateAlert: false });
  });

  it("flags queueAgeAlert when a pending notification has aged past the threshold", () => {
    enqueueTransactionalNotification({
      notificationType: "billing_payment_recovered", sourceDomain: "billing",
      sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, parentId,
      safeVariables: { subscriptionLabel: "Family Plan" },
    }, new Date("2026-08-13T00:00:00.000Z"));
    const health = getNotificationDeliveryHealth(new Date("2026-08-13T01:00:00.000Z"));
    expect(health.pendingCount).toBe(1);
    expect(health.queueAgeAlert).toBe(true);
  });

  it("flags failureRateAlert once permanent failures in the last 24h exceed the threshold", () => {
    for (let i = 0; i < 11; i++) {
      enqueueTransactionalNotification({
        notificationType: "billing_payment_recovered", sourceDomain: "billing",
        sourceEventKey: `evt-fail-${i}`, sourceVersion: 1, parentId,
        safeVariables: { subscriptionLabel: "Family Plan" },
      }, new Date("2026-08-13T00:00:00.000Z"));
    }
    let now = new Date("2026-08-13T00:00:00.000Z");
    const provider = { send: () => ({ status: "failed" as const }) };
    for (let i = 0; i < 6; i++) {
      runNotificationDeliverySweep({ provider, now, limit: 20 });
      now = new Date(now.getTime() + 6 * 60 * 60_000);
    }
    const health = getNotificationDeliveryHealth(now);
    expect(health.permanentFailuresLast24h).toBeGreaterThan(10);
    expect(health.failureRateAlert).toBe(true);
  });
});
