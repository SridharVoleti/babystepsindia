// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import type { TransactionalEmailProvider } from "@/lib/notifications/provider-adapter";
import {
  enqueueTransactionalNotification, NotificationNotFoundError, reconcileNotificationDeliveries,
  runNotificationDeliverySweep, runReconcileApiV1,
} from "@/lib/notifications/service";

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

describe("NT-001 (NT1-G04) runReconcileApiV1", () => {
  it("AT-NT-001: an unresolved delivery with attempts remaining is retried, not immediately permanent", () => {
    const start = new Date("2026-08-13T00:00:00.000Z");
    const notificationId = enqueueAndLeaveUncertain(start);
    const result = runReconcileApiV1({
      limit: 10, runIdempotencyKey: `run-${randomUUID()}`, now: new Date(start.getTime() + 10 * 60_000),
      provider: { send: () => ({ status: "delivered" }), lookup: () => ({ status: "not_found" }) },
    });
    expect(result).toEqual({ reconciled: 0, retried: 1, failed: 0, unchanged: 0, nextCursor: null });
    expect(delivery(notificationId).state).toBe("temporary_failed");
  });

  it("AT-NT-001: a delivery that has already exhausted MAX_DELIVERY_ATTEMPTS is permanently failed, not retried", () => {
    const start = new Date("2026-08-13T00:00:00.000Z");
    const notificationId = enqueueAndLeaveUncertain(start);
    getDb().prepare(
      "update transactional_notification_deliveries set attempt_count=5 where notification_id=?",
    ).run(notificationId);
    const result = runReconcileApiV1({
      limit: 10, runIdempotencyKey: `run-${randomUUID()}`, now: new Date(start.getTime() + 10 * 60_000),
      provider: { send: () => ({ status: "delivered" }), lookup: () => ({ status: "not_found" }) },
    });
    expect(result).toEqual({ reconciled: 0, retried: 0, failed: 1, unchanged: 0, nextCursor: null });
    expect(delivery(notificationId).state).toBe("permanent_failed");
  });

  it("exact notificationId reconciliation affects only that logical notification", () => {
    const start = new Date("2026-08-13T00:00:00.000Z");
    const target = enqueueAndLeaveUncertain(start);
    const other = enqueueAndLeaveUncertain(start);
    const result = runReconcileApiV1({
      notificationId: target, limit: 10, runIdempotencyKey: `run-${randomUUID()}`,
      now: new Date(start.getTime() + 10 * 60_000),
      provider: { send: () => ({ status: "delivered" }), lookup: () => ({ status: "delivered" }) },
    });
    expect(result.reconciled).toBe(1);
    expect(delivery(target).state).toBe("delivered_when_known");
    expect(delivery(other).state).toBe("sending");
  });

  it("an unknown notificationId throws NotificationNotFoundError", () => {
    expect(() => runReconcileApiV1({
      notificationId: randomUUID(), limit: 10, runIdempotencyKey: `run-${randomUUID()}`,
    })).toThrow(NotificationNotFoundError);
  });

  it("cursor batch traversal reconciles a large stale queue across pages with no gaps or duplicates", () => {
    const start = new Date("2026-08-13T00:00:00.000Z");
    const ids = Array.from({ length: 5 }, () => enqueueAndLeaveUncertain(start));
    const now = new Date(start.getTime() + 10 * 60_000);
    const provider = { send: () => ({ status: "delivered" as const }), lookup: () => ({ status: "delivered" as const }) };

    let cursor: string | null = null;
    let pages = 0;
    let totalReconciled = 0;
    do {
      const page = runReconcileApiV1({ cursor, limit: 2, runIdempotencyKey: `run-${randomUUID()}`, now, provider });
      totalReconciled += page.reconciled;
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(pages).toBe(3);
    expect(totalReconciled).toBe(5);
    for (const id of ids) expect(delivery(id).state).toBe("delivered_when_known");
  });
});
