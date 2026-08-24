// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import type { TransactionalEmailProvider } from "@/lib/notifications/provider-adapter";
import {
  enqueueTransactionalNotification, runDeliveryRunApiV1, runNotificationDeliverySweep,
} from "@/lib/notifications/service";

let parentId: string;

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`nt001-del-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
});

async function enqueueOne(overrides: { sourceEventKey?: string } = {}) {
  return await enqueueTransactionalNotification({
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
  it("AT-NT-001-28: blocked_recipient when the parent has no verified email, never guesses an address", async () => {
    const { notificationId } = await enqueueOne();
    const result = await runNotificationDeliverySweep({ now: new Date("2026-08-13T00:00:00.000Z") });
    expect(result.results[0]).toEqual({ notificationId, deliveryState: "blocked_recipient" });
    expect(intentRow(notificationId).state).toBe("blocked_recipient");
    const delivery = deliveryRow(notificationId) as unknown as { recipient_identity_version: string | null; destination_hash: string | null };
    expect(delivery.recipient_identity_version).toBeNull();
    expect(delivery.destination_hash).toBeNull();
  });

  it("NT1-G07: a successful attempt records privacy-safe recipient identity version and destination hash, never the raw email", async () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const { email } = getDb().prepare("select email from users where id=?").get(parentId) as { email: string };
    const { notificationId } = await enqueueOne();
    const provider: TransactionalEmailProvider = { send: () => ({ status: "accepted" }) };
    await runNotificationDeliverySweep({ provider, now: new Date("2026-08-13T00:00:00.000Z") });
    const delivery = deliveryRow(notificationId) as unknown as { recipient_identity_version: string | null; destination_hash: string | null };
    expect(delivery.recipient_identity_version).toBe("2026-08-01T00:00:00.000Z");
    expect(delivery.destination_hash).toBeTruthy();
    expect(delivery.destination_hash).not.toBe(email);
    expect(delivery.destination_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AT-NT-001-30/32: accepted != delivered — accepted state never falsely claims inbox delivery", async () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const { notificationId } = await enqueueOne();
    const provider: TransactionalEmailProvider = { send: () => ({ status: "accepted", providerMessageId: "pm-1" }) };
    await runNotificationDeliverySweep({ provider, now: new Date("2026-08-13T00:00:00.000Z") });
    const delivery = deliveryRow(notificationId)!;
    expect(delivery.state).toBe("accepted");
    expect(delivery.provider_message_id).toBe("pm-1");
    expect(intentRow(notificationId).state).toBe("sent");
  });

  it("delivered_when_known is used only when the provider gives a trustworthy delivery confirmation", async () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const { notificationId } = await enqueueOne();
    const provider: TransactionalEmailProvider = { send: () => ({ status: "delivered", providerMessageId: "pm-2" }) };
    await runNotificationDeliverySweep({ provider, now: new Date("2026-08-13T00:00:00.000Z") });
    expect(deliveryRow(notificationId)!.state).toBe("delivered_when_known");
  });

  it("AT-NT-001-34: a temporary provider failure schedules a bounded retry, not permanent failure", async () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const { notificationId } = await enqueueOne();
    const provider: TransactionalEmailProvider = { send: () => ({ status: "failed" }) };
    await runNotificationDeliverySweep({ provider, now: new Date("2026-08-13T00:00:00.000Z") });
    const delivery = deliveryRow(notificationId)!;
    expect(delivery.state).toBe("temporary_failed");
    const intent = intentRow(notificationId);
    expect(intent.state).toBe("pending");
    expect(intent.next_attempt_at).not.toBeNull();
  });

  it("AT-NT-001-35: repeated temporary failures eventually reach permanent_failed, no infinite retry", async () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const { notificationId } = await enqueueOne();
    const provider: TransactionalEmailProvider = { send: () => ({ status: "failed" }) };
    let now = new Date("2026-08-13T00:00:00.000Z");
    for (let i = 0; i < 6; i++) {
      await runNotificationDeliverySweep({ provider, now });
      now = new Date(now.getTime() + 6 * 60 * 60_000); // fast-forward well past any backoff window
    }
    const delivery = deliveryRow(notificationId)!;
    expect(delivery.state).toBe("permanent_failed");
    expect(intentRow(notificationId).state).toBe("failed");
    expect(delivery.attempt_count).toBeLessThanOrEqual(5);
  });

  it("AT-NT-001-36: an uncertain send leaves the intent claimed for reconciliation, not blindly retried", async () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const { notificationId } = await enqueueOne();
    const provider: TransactionalEmailProvider = { send: () => ({ status: "uncertain" }) };
    await runNotificationDeliverySweep({ provider, now: new Date("2026-08-13T00:00:00.000Z") });
    expect(deliveryRow(notificationId)!.state).toBe("sending");
    expect(intentRow(notificationId).state).toBe("claimed");
    // a second sweep run must not pick this notification up again — it's no longer 'pending'
    const secondSweep = await runNotificationDeliverySweep({ provider, now: new Date("2026-08-13T01:00:00.000Z") });
    expect(secondSweep.results.find((r) => r.notificationId === notificationId)).toBeUndefined();
  });

  it("a bounded batch never claims more than `limit` intents in one sweep", async () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    for (let i = 0; i < 5; i++) await enqueueOne();
    const provider: TransactionalEmailProvider = { send: () => ({ status: "accepted" }) };
    const result = await runNotificationDeliverySweep({ provider, limit: 2, now: new Date("2026-08-13T00:00:00.000Z") });
    expect(result.claimed).toBe(2);
  });

  it("renders with the recipient's real current verified email as the send destination", async () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const { email } = getDb().prepare("select email from users where id=?").get(parentId) as { email: string };
    await enqueueOne();
    let sentTo: string | undefined;
    const provider: TransactionalEmailProvider = {
      send: (input) => { sentTo = input.to; return { status: "accepted" }; },
    };
    await runNotificationDeliverySweep({ provider, now: new Date("2026-08-13T00:00:00.000Z") });
    expect(sentTo).toBe(email);
  });
});

describe("NT-001 (NT1-G03) runDeliveryRunApiV1 cursor continuation", () => {
  it("AT-NT-001: a large queue processes across multiple pages with no gaps or duplicates", async () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const notificationIds: string[] = [];
    for (let i = 0; i < 5; i++) notificationIds.push((await enqueueOne()).notificationId);
    const provider: TransactionalEmailProvider = { send: () => ({ status: "accepted" }) };
    const now = new Date("2026-08-13T00:00:00.000Z");

    let cursor: string | null = null;
    let pages = 0;
    let totalProcessed = 0;
    do {
      const page = await runDeliveryRunApiV1({
        cursor, limit: 2, runIdempotencyKey: `run-${randomUUID()}`, provider, now,
      });
      expect(page.processed).toBeLessThanOrEqual(2);
      totalProcessed += page.processed;
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(pages).toBe(3);
    expect(totalProcessed).toBe(5);
    for (const id of notificationIds) expect(intentRow(id).state).toBe("sent");
  });

  it("NT1-G03: a fresh cursor sees no eligible work (nextCursor null) once the queue is drained", async () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    await enqueueOne();
    const provider: TransactionalEmailProvider = { send: () => ({ status: "accepted" }) };
    const now = new Date("2026-08-13T00:00:00.000Z");
    await runDeliveryRunApiV1({ limit: 10, runIdempotencyKey: `run-${randomUUID()}`, provider, now });
    const empty = await runDeliveryRunApiV1({ limit: 10, runIdempotencyKey: `run-${randomUUID()}`, provider, now });
    expect(empty.processed).toBe(0);
    expect(empty.nextCursor).toBeNull();
  });
});
