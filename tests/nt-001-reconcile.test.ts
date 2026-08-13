// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import type { TransactionalEmailProvider } from "@/lib/notifications/provider-adapter";
import { enqueueTransactionalNotification, reconcileNotificationDeliveries, runNotificationDeliverySweep } from
  "@/lib/notifications/service";

let parentId: string;

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`nt001-rec-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
});

function enqueueAndLeaveUncertain(now: Date) {
  const { notificationId } = enqueueTransactionalNotification({
    notificationType: "billing_payment_recovered", sourceDomain: "billing",
    sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, parentId,
    safeVariables: { subscriptionLabel: "Family Plan" },
  });
  const uncertainProvider: TransactionalEmailProvider = { send: () => ({ status: "uncertain" }) };
  runNotificationDeliverySweep({ provider: uncertainProvider, now });
  return notificationId;
}

function delivery(notificationId: string) {
  return getDb().prepare("select * from transactional_notification_deliveries where notification_id=?")
    .get(notificationId) as { state: string };
}

describe("NT-001 reconcileNotificationDeliveries (AT-NT-001-36)", () => {
  it("does not reconcile an uncertain delivery before it's stale", () => {
    const start = new Date("2026-08-13T00:00:00.000Z");
    const notificationId = enqueueAndLeaveUncertain(start);
    const result = reconcileNotificationDeliveries({
      now: new Date(start.getTime() + 60_000), provider: { send: () => ({ status: "delivered" }),
        lookup: () => ({ status: "delivered" }) },
    });
    expect(result.reconciled).toBe(0);
    expect(delivery(notificationId).state).toBe("sending");
  });

  it("resolves a stale uncertain delivery to delivered_when_known via provider.lookup", () => {
    const start = new Date("2026-08-13T00:00:00.000Z");
    const notificationId = enqueueAndLeaveUncertain(start);
    const result = reconcileNotificationDeliveries({
      now: new Date(start.getTime() + 10 * 60_000),
      provider: { send: () => ({ status: "delivered" }), lookup: () => ({ status: "delivered" }) },
    });
    expect(result.results).toEqual([{ notificationId, outcome: "delivered_when_known" }]);
    expect(delivery(notificationId).state).toBe("delivered_when_known");
  });

  it("resolves a stale uncertain delivery to permanent_failed when the provider never accepted it", () => {
    const start = new Date("2026-08-13T00:00:00.000Z");
    const notificationId = enqueueAndLeaveUncertain(start);
    const result = reconcileNotificationDeliveries({
      now: new Date(start.getTime() + 10 * 60_000),
      provider: { send: () => ({ status: "delivered" }), lookup: () => ({ status: "not_found" }) },
    });
    expect(result.results).toEqual([{ notificationId, outcome: "permanent_failed" }]);
    expect(delivery(notificationId).state).toBe("permanent_failed");
  });

  it("leaves a delivery still_uncertain if the lookup itself is still pending, without a blind resend", () => {
    const start = new Date("2026-08-13T00:00:00.000Z");
    const notificationId = enqueueAndLeaveUncertain(start);
    const result = reconcileNotificationDeliveries({
      now: new Date(start.getTime() + 10 * 60_000),
      provider: { send: () => ({ status: "delivered" }), lookup: () => ({ status: "pending" }) },
    });
    expect(result.results).toEqual([{ notificationId, outcome: "still_uncertain" }]);
    expect(delivery(notificationId).state).toBe("sending");
  });
});
