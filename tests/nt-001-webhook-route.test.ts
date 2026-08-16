// @vitest-environment node
import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { enqueueTransactionalNotification, runNotificationDeliverySweep } from "@/lib/notifications/service";
import { POST as postProviderEvent } from "@/app/v1/internal/notifications/provider-events/route";

const SECRET = "test-webhook-secret-at-least-32-chars-long";
let parentId: string;
const originalSecret = process.env.NOTIFICATION_PROVIDER_WEBHOOK_SECRET;

beforeEach(async () => {
  useInMemoryDb();
  process.env.NOTIFICATION_PROVIDER_WEBHOOK_SECRET = SECRET;
  const { user } = await sqliteAuthAdapter.signUp(`nt001-wh-route-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
});

afterEach(() => { process.env.NOTIFICATION_PROVIDER_WEBHOOK_SECRET = originalSecret; });

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
    .get(notificationId) as { provider_idempotency_key: string };
}

describe("NT-001 (NT1-G05) POST /v1/internal/notifications/provider-events HTTP status mapping", () => {
  it("valid callback -> 200 acknowledged", async () => {
    const notificationId = sendOneAccepted();
    const providerIdempotencyKey = deliveryFor(notificationId).provider_idempotency_key;
    const now = new Date();
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const bodyPayload = { providerIdempotencyKey, eventType: "delivered", occurredAt: now.toISOString() };
    const rawBody = JSON.stringify({ provider: "local", eventId: randomUUID(), ...bodyPayload });
    const response = await postProviderEvent(new Request("http://localhost/v1/internal/notifications/provider-events", {
      method: "POST",
      headers: { "x-babysteps-webhook-signature": sign(timestampSeconds, rawBody), "x-babysteps-webhook-timestamp": String(timestampSeconds) },
      body: rawBody,
    }));
    expect(response.status).toBe(200);
  });

  it("invalid signature -> 401", async () => {
    const now = new Date();
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const rawBody = JSON.stringify({ provider: "local", eventId: randomUUID(), providerIdempotencyKey: "nt001:x",
      eventType: "delivered", occurredAt: now.toISOString() });
    const response = await postProviderEvent(new Request("http://localhost/v1/internal/notifications/provider-events", {
      method: "POST",
      headers: { "x-babysteps-webhook-signature": "deadbeef", "x-babysteps-webhook-timestamp": String(timestampSeconds) },
      body: rawBody,
    }));
    expect(response.status).toBe(401);
  });

  it("replayed event id -> 401", async () => {
    const notificationId = sendOneAccepted();
    const providerIdempotencyKey = deliveryFor(notificationId).provider_idempotency_key;
    const now = new Date();
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const eventId = randomUUID();
    const rawBody = JSON.stringify({ provider: "local", eventId, providerIdempotencyKey, eventType: "delivered",
      occurredAt: now.toISOString() });
    const headers = { "x-babysteps-webhook-signature": sign(timestampSeconds, rawBody), "x-babysteps-webhook-timestamp": String(timestampSeconds) };
    await postProviderEvent(new Request("http://localhost/v1/internal/notifications/provider-events", { method: "POST", headers, body: rawBody }));
    const replay = await postProviderEvent(new Request("http://localhost/v1/internal/notifications/provider-events", { method: "POST", headers, body: rawBody }));
    expect(replay.status).toBe(401);
  });

  it("unknown provider identity -> 404", async () => {
    const now = new Date();
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const rawBody = JSON.stringify({ provider: "local", eventId: randomUUID(), providerIdempotencyKey: "nt001:unknown",
      eventType: "delivered", occurredAt: now.toISOString() });
    const response = await postProviderEvent(new Request("http://localhost/v1/internal/notifications/provider-events", {
      method: "POST",
      headers: { "x-babysteps-webhook-signature": sign(timestampSeconds, rawBody), "x-babysteps-webhook-timestamp": String(timestampSeconds) },
      body: rawBody,
    }));
    expect(response.status).toBe(404);
  });

  it("invalid state regression -> 409", async () => {
    const notificationId = sendOneAccepted();
    const providerIdempotencyKey = deliveryFor(notificationId).provider_idempotency_key;
    const now = new Date();
    const timestampSeconds = Math.floor(now.getTime() / 1000);
    const deliveredBody = JSON.stringify({ provider: "local", eventId: randomUUID(), providerIdempotencyKey,
      eventType: "delivered", occurredAt: now.toISOString() });
    await postProviderEvent(new Request("http://localhost/v1/internal/notifications/provider-events", {
      method: "POST",
      headers: { "x-babysteps-webhook-signature": sign(timestampSeconds, deliveredBody), "x-babysteps-webhook-timestamp": String(timestampSeconds) },
      body: deliveredBody,
    }));

    const laterNow = new Date(Date.now() + 60_000);
    const laterTimestampSeconds = Math.floor(laterNow.getTime() / 1000);
    const regressBody = JSON.stringify({ provider: "local", eventId: randomUUID(), providerIdempotencyKey,
      eventType: "accepted", occurredAt: laterNow.toISOString() });
    const response = await postProviderEvent(new Request("http://localhost/v1/internal/notifications/provider-events", {
      method: "POST",
      headers: { "x-babysteps-webhook-signature": sign(laterTimestampSeconds, regressBody), "x-babysteps-webhook-timestamp": String(laterTimestampSeconds) },
      body: regressBody,
    }));
    expect(response.status).toBe(409);
  });

  it("invalid payload -> 400", async () => {
    const response = await postProviderEvent(new Request("http://localhost/v1/internal/notifications/provider-events", {
      method: "POST", headers: { "x-babysteps-webhook-signature": "x", "x-babysteps-webhook-timestamp": "123" },
      body: "not-json",
    }));
    expect(response.status).toBe(400);
  });
});
