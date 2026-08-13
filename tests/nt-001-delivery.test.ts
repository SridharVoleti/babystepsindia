// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import type { TransactionalEmailProvider } from "@/lib/notifications/provider-adapter";
import { enqueueTransactionalNotification, runNotificationDeliverySweep } from "@/lib/notifications/service";

let parentId: string;

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`nt001-del-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
});

function enqueueOne(overrides: { sourceEventKey?: string } = {}) {
  return enqueueTransactionalNotification({
    notificationType: "billing_payment_recovered", sourceDomain: "billing",
    sourceEventKey: overrides.sourceEventKey ?? `evt-${randomUUID()}`, sourceVersion: 1, parentId,
    safeVariables: { subscriptionLabel: "Family Plan" },
  });
}

function deliveryRow(notificationId: string) {
  return getDb().prepare("select * from transactional_notification_deliveries where notification_id=?")
    .get(notificationId) as { state: string; provider_message_id: string | null; attempt_count: number } | undefined;
}

function intentRow(notificationId: string) {
  return getDb().prepare("select * from transactional_notification_intents where notification_id=?")
    .get(notificationId) as { state: string; next_attempt_at: string | null; attempt_count: number };
}

describe("NT-001 runNotificationDeliverySweep", () => {
  it("AT-NT-001-28: blocked_recipient when the parent has no verified email, never guesses an address", () => {
    const { notificationId } = enqueueOne();
    const result = runNotificationDeliverySweep({ now: new Date("2026-08-13T00:00:00.000Z") });
    expect(result.results[0]).toEqual({ notificationId, deliveryState: "blocked_recipient" });
    expect(intentRow(notificationId).state).toBe("blocked_recipient");
  });

  it("AT-NT-001-30/32: accepted != delivered — accepted state never falsely claims inbox delivery", () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const { notificationId } = enqueueOne();
    const provider: TransactionalEmailProvider = { send: () => ({ status: "accepted", providerMessageId: "pm-1" }) };
    runNotificationDeliverySweep({ provider, now: new Date("2026-08-13T00:00:00.000Z") });
    const delivery = deliveryRow(notificationId)!;
    expect(delivery.state).toBe("accepted");
    expect(delivery.provider_message_id).toBe("pm-1");
    expect(intentRow(notificationId).state).toBe("sent");
  });

  it("delivered_when_known is used only when the provider gives a trustworthy delivery confirmation", () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const { notificationId } = enqueueOne();
    const provider: TransactionalEmailProvider = { send: () => ({ status: "delivered", providerMessageId: "pm-2" }) };
    runNotificationDeliverySweep({ provider, now: new Date("2026-08-13T00:00:00.000Z") });
    expect(deliveryRow(notificationId)!.state).toBe("delivered_when_known");
  });

  it("AT-NT-001-34: a temporary provider failure schedules a bounded retry, not permanent failure", () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const { notificationId } = enqueueOne();
    const provider: TransactionalEmailProvider = { send: () => ({ status: "failed" }) };
    runNotificationDeliverySweep({ provider, now: new Date("2026-08-13T00:00:00.000Z") });
    const delivery = deliveryRow(notificationId)!;
    expect(delivery.state).toBe("temporary_failed");
    const intent = intentRow(notificationId);
    expect(intent.state).toBe("pending");
    expect(intent.next_attempt_at).not.toBeNull();
  });

  it("AT-NT-001-35: repeated temporary failures eventually reach permanent_failed, no infinite retry", () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const { notificationId } = enqueueOne();
    const provider: TransactionalEmailProvider = { send: () => ({ status: "failed" }) };
    let now = new Date("2026-08-13T00:00:00.000Z");
    for (let i = 0; i < 6; i++) {
      runNotificationDeliverySweep({ provider, now });
      now = new Date(now.getTime() + 6 * 60 * 60_000); // fast-forward well past any backoff window
    }
    const delivery = deliveryRow(notificationId)!;
    expect(delivery.state).toBe("permanent_failed");
    expect(intentRow(notificationId).state).toBe("failed");
    expect(delivery.attempt_count).toBeLessThanOrEqual(5);
  });

  it("AT-NT-001-36: an uncertain send leaves the intent claimed for reconciliation, not blindly retried", () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const { notificationId } = enqueueOne();
    const provider: TransactionalEmailProvider = { send: () => ({ status: "uncertain" }) };
    runNotificationDeliverySweep({ provider, now: new Date("2026-08-13T00:00:00.000Z") });
    expect(deliveryRow(notificationId)!.state).toBe("sending");
    expect(intentRow(notificationId).state).toBe("claimed");
    // a second sweep run must not pick this notification up again — it's no longer 'pending'
    const secondSweep = runNotificationDeliverySweep({ provider, now: new Date("2026-08-13T01:00:00.000Z") });
    expect(secondSweep.results.find((r) => r.notificationId === notificationId)).toBeUndefined();
  });

  it("a bounded batch never claims more than `limit` intents in one sweep", () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    for (let i = 0; i < 5; i++) enqueueOne();
    const provider: TransactionalEmailProvider = { send: () => ({ status: "accepted" }) };
    const result = runNotificationDeliverySweep({ provider, limit: 2, now: new Date("2026-08-13T00:00:00.000Z") });
    expect(result.claimed).toBe(2);
  });

  it("renders with the recipient's real current verified email as the send destination", () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const { email } = getDb().prepare("select email from users where id=?").get(parentId) as { email: string };
    enqueueOne();
    let sentTo: string | undefined;
    const provider: TransactionalEmailProvider = {
      send: (input) => { sentTo = input.to; return { status: "accepted" }; },
    };
    runNotificationDeliverySweep({ provider, now: new Date("2026-08-13T00:00:00.000Z") });
    expect(sentTo).toBe(email);
  });
});
