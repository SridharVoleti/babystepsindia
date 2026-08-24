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

async function enqueueAt(createdAt: string) {
  const { notificationId } = await enqueueTransactionalNotification({
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
  it("AT-NT-001-43: purges intents older than the 13-month default", async () => {
    const oldId = await enqueueAt("2025-01-01T00:00:00.000Z");
    const recentId = await enqueueAt("2026-08-01T00:00:00.000Z");
    const result = await purgeExpiredNotificationMetadata(new Date("2026-08-13T00:00:00.000Z"));
    expect(result.intentsPurged).toBe(1);
    const remaining = getDb().prepare("select notification_id from transactional_notification_intents").all() as
      { notification_id: string }[];
    expect(remaining.map((r) => r.notification_id)).toEqual([recentId]);
    expect(remaining.map((r) => r.notification_id)).not.toContain(oldId);
  });

  it("AT-NT-001-42: cleanup removes NO permanent full body — delivery rows cascade-delete with their intent", async () => {
    const oldId = await enqueueAt("2025-01-01T00:00:00.000Z");
    await runNotificationDeliverySweep({ now: new Date("2025-01-01T00:00:00.000Z") });
    expect((getDb().prepare("select count(*) n from transactional_notification_deliveries where notification_id=?")
      .get(oldId) as { n: number }).n).toBeGreaterThan(0);
    await purgeExpiredNotificationMetadata(new Date("2026-08-13T00:00:00.000Z"));
    expect((getDb().prepare("select count(*) n from transactional_notification_deliveries where notification_id=?")
      .get(oldId) as { n: number }).n).toBe(0);
  });

  it("AT-NT-001-44: cleanup never touches source-domain tables (billing/subscriptions untouched)", async () => {
    await enqueueAt("2025-01-01T00:00:00.000Z");
    const before = getDb().prepare("select count(*) n from subscriptions").get() as { n: number };
    await purgeExpiredNotificationMetadata(new Date("2026-08-13T00:00:00.000Z"));
    const after = getDb().prepare("select count(*) n from subscriptions").get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});

describe("NT-001 getNotificationDeliveryHealth (AT-NT-001-48)", () => {
  it("reports zero pending/no alerts when the queue is empty", async () => {
    const health = await getNotificationDeliveryHealth(new Date("2026-08-13T00:00:00.000Z"));
    expect(health).toMatchObject({ pendingCount: 0, oldestPendingAgeMs: null, queueAgeAlert: false,
      failureRateAlert: false });
  });

  it("flags queueAgeAlert when a pending notification has aged past the threshold", async () => {
    await enqueueTransactionalNotification({
      notificationType: "billing_payment_recovered", sourceDomain: "billing",
      sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, parentId,
      safeVariables: { subscriptionLabel: "Family Plan" },
    }, new Date("2026-08-13T00:00:00.000Z"));
    const health = await getNotificationDeliveryHealth(new Date("2026-08-13T01:00:00.000Z"));
    expect(health.pendingCount).toBe(1);
    expect(health.queueAgeAlert).toBe(true);
  });

  it("flags failureRateAlert once permanent failures in the last 24h exceed the threshold", async () => {
    for (let i = 0; i < 11; i++) {
      await enqueueTransactionalNotification({
        notificationType: "billing_payment_recovered", sourceDomain: "billing",
        sourceEventKey: `evt-fail-${i}`, sourceVersion: 1, parentId,
        safeVariables: { subscriptionLabel: "Family Plan" },
      }, new Date("2026-08-13T00:00:00.000Z"));
    }
    let now = new Date("2026-08-13T00:00:00.000Z");
    const provider = { send: () => ({ status: "failed" as const }) };
    for (let i = 0; i < 6; i++) {
      await runNotificationDeliverySweep({ provider, now, limit: 20 });
      now = new Date(now.getTime() + 6 * 60 * 60_000);
    }
    const health = await getNotificationDeliveryHealth(now);
    expect(health.permanentFailuresLast24h).toBeGreaterThan(10);
    expect(health.failureRateAlert).toBe(true);
  });

  it("NT1-G08: flags providerHealthDegraded on a burst of recent temporary provider failures", async () => {
    for (let i = 0; i < 5; i++) {
      await enqueueTransactionalNotification({
        notificationType: "billing_payment_recovered", sourceDomain: "billing",
        sourceEventKey: `evt-degraded-${i}`, sourceVersion: 1, parentId,
        safeVariables: { subscriptionLabel: "Family Plan" },
      }, new Date("2026-08-13T00:00:00.000Z"));
    }
    const now = new Date("2026-08-13T00:00:00.000Z");
    const provider = { send: () => ({ status: "failed" as const }) };
    await runNotificationDeliverySweep({ provider, now, limit: 20 });
    const health = await getNotificationDeliveryHealth(new Date(now.getTime() + 60_000));
    expect(health.recentTemporaryFailures).toBe(5);
    expect(health.providerHealthDegraded).toBe(true);
  });

  it("NT1-G08: a provider outage never blocks the source domain's own enqueue commit", async () => {
    // enqueueTransactionalNotification never touches the email provider at
    // all — only runNotificationDeliverySweep/runDeliveryRunApiV1 do, later
    // and asynchronously. This is a structural guarantee, not a mock: the
    // call below succeeds with no provider involved whatsoever.
    const result = await enqueueTransactionalNotification({
      notificationType: "billing_payment_recovered", sourceDomain: "billing",
      sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, parentId,
      safeVariables: { subscriptionLabel: "Family Plan" },
    }, new Date("2026-08-13T00:00:00.000Z"));
    expect(result.state).toBe("pending");
  });
});
