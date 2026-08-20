// @vitest-environment node
import { createHmac, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { enqueueTransactionalNotification, runNotificationDeliverySweep } from "@/lib/notifications/service";
import { ingestNotificationProviderEvent, NotificationWebhookError } from "@/lib/notifications/webhook";

const SECRET = "test-webhook-secret";
let parentId: string;

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`nt001-wh-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
});

function sign(timestampSeconds: number, rawBody: string) {
  return createHmac("sha256", SECRET).update(`${timestampSeconds}.${rawBody}`).digest("hex");
}

function sendOneAccepted() {
  const { notificationId } = enqueueTransactionalNotification({
    notificationType: "billing_payment_recovered", sourceDomain: "billing",
    sourceEventKey: `evt-${randomUUID()}`, sourceVersion: 1, parentId,
    safeVariables: { subscriptionLabel: "Family Plan" },
  });
  runNotificationDeliverySweep({
    provider: { send: () => ({ status: "accepted", providerMessageId: "pm-1" }) },
    now: new Date("2026-08-13T00:00:00.000Z"),
  });
  return notificationId;
}

function deliveryFor(notificationId: string) {
  return getDb().prepare("select * from transactional_notification_deliveries where notification_id=?")
    .get(notificationId) as { state: string; provider_idempotency_key: string };
}

describe("NT-001 ingestNotificationProviderEvent", () => {
  it("AT-NT-001-32: rejects a forged/bad signature", async () => {
    const now = new Date("2026-08-13T00:05:00.000Z");
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const rawBody = JSON.stringify({ providerIdempotencyKey: "nt001:x", eventType: "delivered",
      occurredAt: now.toISOString() });
    await expect(ingestNotificationProviderEvent({
      provider: "local", providerEventId: randomUUID(), timestampSeconds, signatureHex: "deadbeef",
      rawBody, secret: SECRET, now,
    })).rejects.toThrow(NotificationWebhookError);
  });

  it("AT-NT-001-31: a signed delivered callback updates the delivery to delivered_when_known", async () => {
    const notificationId = sendOneAccepted();
    const providerIdempotencyKey = deliveryFor(notificationId).provider_idempotency_key;
    const now = new Date("2026-08-13T00:05:00.000Z");
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const rawBody = JSON.stringify({ providerIdempotencyKey, eventType: "delivered", occurredAt: now.toISOString() });
    const result = await ingestNotificationProviderEvent({
      provider: "local", providerEventId: randomUUID(), timestampSeconds, signatureHex: sign(timestampSeconds, rawBody),
      rawBody, secret: SECRET, now,
    });
    expect(result).toEqual({ applied: true, deliveryState: "delivered_when_known" });
    expect(deliveryFor(notificationId).state).toBe("delivered_when_known");
  });

  it("AT-NT-001-33: a replayed provider event id does not duplicate/regress delivery state", async () => {
    const notificationId = sendOneAccepted();
    const providerIdempotencyKey = deliveryFor(notificationId).provider_idempotency_key;
    const now = new Date("2026-08-13T00:05:00.000Z");
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const rawBody = JSON.stringify({ providerIdempotencyKey, eventType: "delivered", occurredAt: now.toISOString() });
    const providerEventId = randomUUID();
    await ingestNotificationProviderEvent({
      provider: "local", providerEventId, timestampSeconds, signatureHex: sign(timestampSeconds, rawBody),
      rawBody, secret: SECRET, now,
    });
    await expect(ingestNotificationProviderEvent({
      provider: "local", providerEventId, timestampSeconds, signatureHex: sign(timestampSeconds, rawBody),
      rawBody, secret: SECRET, now,
    })).rejects.toThrow(/WEBHOOK_REPLAYED/);
  });

  it("NT1-G05/AT-NT-001-37: a late 'accepted' callback after delivered_when_known is rejected as a state regression, not silently accepted", async () => {
    const notificationId = sendOneAccepted();
    const providerIdempotencyKey = deliveryFor(notificationId).provider_idempotency_key;
    const now = new Date("2026-08-13T00:05:00.000Z");
    let timestampSeconds = Math.floor(now.getTime() / 1000);
    let rawBody = JSON.stringify({ providerIdempotencyKey, eventType: "delivered", occurredAt: now.toISOString() });
    await ingestNotificationProviderEvent({
      provider: "local", providerEventId: randomUUID(), timestampSeconds, signatureHex: sign(timestampSeconds, rawBody),
      rawBody, secret: SECRET, now,
    });
    expect(deliveryFor(notificationId).state).toBe("delivered_when_known");

    const laterNow = new Date("2026-08-13T00:10:00.000Z");
    timestampSeconds = Math.floor(laterNow.getTime() / 1000);
    rawBody = JSON.stringify({ providerIdempotencyKey, eventType: "accepted", occurredAt: laterNow.toISOString() });
    await expect(ingestNotificationProviderEvent({
      provider: "local", providerEventId: randomUUID(), timestampSeconds, signatureHex: sign(timestampSeconds, rawBody),
      rawBody, secret: SECRET, now: laterNow,
    })).rejects.toThrow(/WEBHOOK_STATE_REGRESSION/);
    expect(deliveryFor(notificationId).state).toBe("delivered_when_known");
  });

  it("NT1-G05: an exact duplicate of the already-recorded terminal state stays idempotent (200-equivalent), not a regression", async () => {
    const notificationId = sendOneAccepted();
    const providerIdempotencyKey = deliveryFor(notificationId).provider_idempotency_key;
    const now = new Date("2026-08-13T00:05:00.000Z");
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const rawBody = JSON.stringify({ providerIdempotencyKey, eventType: "delivered", occurredAt: now.toISOString() });
    await ingestNotificationProviderEvent({
      provider: "local", providerEventId: randomUUID(), timestampSeconds, signatureHex: sign(timestampSeconds, rawBody),
      rawBody, secret: SECRET, now,
    });
    const laterNow = new Date("2026-08-13T00:10:00.000Z");
    const laterTimestampSeconds = Math.floor(laterNow.getTime() / 1000);
    const laterRawBody = JSON.stringify({ providerIdempotencyKey, eventType: "delivered", occurredAt: laterNow.toISOString() });
    const result = await ingestNotificationProviderEvent({
      provider: "local", providerEventId: randomUUID(), timestampSeconds: laterTimestampSeconds,
      signatureHex: sign(laterTimestampSeconds, laterRawBody), rawBody: laterRawBody, secret: SECRET, now: laterNow,
    });
    expect(result).toEqual({ applied: false, reason: "ALREADY_TERMINAL" });
  });

  it("NT1-G05: an unknown provider identity is rejected safely, not silently accepted", async () => {
    const now = new Date("2026-08-13T00:05:00.000Z");
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const rawBody = JSON.stringify({ providerIdempotencyKey: "nt001:unknown", eventType: "delivered", occurredAt: now.toISOString() });
    await expect(ingestNotificationProviderEvent({
      provider: "local", providerEventId: randomUUID(), timestampSeconds, signatureHex: sign(timestampSeconds, rawBody),
      rawBody, secret: SECRET, now,
    })).rejects.toThrow(/WEBHOOK_UNKNOWN_DELIVERY/);
  });

  it("rejects a stale timestamp outside the tolerance window", async () => {
    const now = new Date("2026-08-13T00:05:00.000Z");
    const staleTimestampSeconds = Math.floor(now.getTime() / 1000) - 3600;
    const rawBody = JSON.stringify({ providerIdempotencyKey: "nt001:x", eventType: "delivered",
      occurredAt: now.toISOString() });
    await expect(ingestNotificationProviderEvent({
      provider: "local", providerEventId: randomUUID(), timestampSeconds: staleTimestampSeconds,
      signatureHex: sign(staleTimestampSeconds, rawBody), rawBody, secret: SECRET, now,
    })).rejects.toThrow(NotificationWebhookError);
  });

  it("a bounce/failed callback moves an accepted delivery to permanent_failed", async () => {
    const notificationId = sendOneAccepted();
    const providerIdempotencyKey = deliveryFor(notificationId).provider_idempotency_key;
    const now = new Date("2026-08-13T00:05:00.000Z");
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const rawBody = JSON.stringify({ providerIdempotencyKey, eventType: "bounced", occurredAt: now.toISOString() });
    const result = await ingestNotificationProviderEvent({
      provider: "local", providerEventId: randomUUID(), timestampSeconds, signatureHex: sign(timestampSeconds, rawBody),
      rawBody, secret: SECRET, now,
    });
    expect(result).toEqual({ applied: true, deliveryState: "permanent_failed" });
  });
});
