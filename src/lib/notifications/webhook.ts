import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db/client";

export class NotificationWebhookError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "NotificationWebhookError"; }
}

// Same HMAC-SHA256-over-timestamp.rawBody shape as
// bi005-service.ts's ingestFinancialEventWebhook / AR-002's
// ingestDeploymentWebhook — duplicated locally since no shared
// src/lib/webhooks/hmac.ts utility exists in this codebase yet.
const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

type ProviderWebhookPayload = {
  providerIdempotencyKey: string;
  eventType: "accepted" | "delivered" | "bounced" | "failed";
  occurredAt: string;
};

export type IngestNotificationProviderEventInput = {
  provider: string; providerEventId: string; timestampSeconds: number; signatureHex: string;
  rawBody: string; secret: string; now: Date;
};

export type IngestNotificationProviderEventResult =
  | { applied: true; deliveryState: string }
  | { applied: false; reason: "ALREADY_TERMINAL" };

// Rule 59: once a delivery reaches one of these it is terminal for webhook
// purposes — a late/duplicate callback never regresses it (rule 71, AT-37).
const TERMINAL_STATES = new Set(["delivered_when_known", "permanent_failed", "blocked_recipient", "suppressed_by_policy"]);

// API-NT-003: signed, replay-rejecting, idempotent provider callback
// ingestion (rules 69-71, AT-31/32/33/37).
export function ingestNotificationProviderEvent(
  input: IngestNotificationProviderEventInput,
): IngestNotificationProviderEventResult {
  if (!Number.isFinite(input.timestampSeconds)) throw new NotificationWebhookError("WEBHOOK_AUTHENTICATION_FAILED");
  const skewMs = Math.abs(input.now.getTime() - input.timestampSeconds * 1000);
  if (skewMs > WEBHOOK_TIMESTAMP_TOLERANCE_MS) throw new NotificationWebhookError("WEBHOOK_AUTHENTICATION_FAILED");
  const expectedSignature = createHmac("sha256", input.secret)
    .update(`${input.timestampSeconds}.${input.rawBody}`).digest("hex");
  if (!safeEqual(expectedSignature, input.signatureHex)) throw new NotificationWebhookError("WEBHOOK_AUTHENTICATION_FAILED");

  let payload: ProviderWebhookPayload;
  try { payload = JSON.parse(input.rawBody); } catch { throw new NotificationWebhookError("INVALID_REQUEST"); }
  if (typeof payload.providerIdempotencyKey !== "string" || typeof payload.occurredAt !== "string"
    || !["accepted", "delivered", "bounced", "failed"].includes(payload.eventType)) {
    throw new NotificationWebhookError("INVALID_REQUEST");
  }

  const db = getDb();
  return db.transaction((): IngestNotificationProviderEventResult => {
    const existingReceipt = db.prepare(
      "select 1 from notification_provider_webhook_receipts where provider=? and provider_event_id=?",
    ).get(input.provider, input.providerEventId);
    if (existingReceipt) throw new NotificationWebhookError("WEBHOOK_REPLAYED");
    db.prepare(
      "insert into notification_provider_webhook_receipts (id,provider,provider_event_id,received_at) values (?,?,?,?)",
    ).run(randomUUID(), input.provider, input.providerEventId, input.now.toISOString());

    const delivery = db.prepare(
      "select id, notification_id, state from transactional_notification_deliveries where provider_idempotency_key=?",
    ).get(payload.providerIdempotencyKey) as { id: string; notification_id: string; state: string } | undefined;
    // NT1-G05: unknown provider identity is a safe 404 (no sensitive detail
    // beyond "not found"), never a silent 200 no-op — callers must be able
    // to tell "we don't know this delivery" from "we know it and it's done".
    if (!delivery) throw new NotificationWebhookError("WEBHOOK_UNKNOWN_DELIVERY");

    const nextState = payload.eventType === "delivered" ? "delivered_when_known"
      : payload.eventType === "accepted" ? "accepted"
      : "permanent_failed";
    if (TERMINAL_STATES.has(delivery.state)) {
      // Rule 71/AT-37: an exact re-delivery of the same already-recorded
      // terminal state is a benign duplicate/out-of-order callback (stays
      // idempotent, 200) — but a callback that would actually move the
      // state (e.g. a late 'accepted' arriving after 'delivered_when_known')
      // is a genuine monotonic regression attempt, reserved for 409.
      if (delivery.state === nextState) return { applied: false, reason: "ALREADY_TERMINAL" };
      throw new NotificationWebhookError("WEBHOOK_STATE_REGRESSION");
    }
    const timestamp = input.now.toISOString();
    db.prepare(
      "update transactional_notification_deliveries set state=?,delivered_at=?,updated_at=? where id=?",
    ).run(nextState, nextState === "delivered_when_known" ? timestamp : null, timestamp, delivery.id);
    if (nextState === "delivered_when_known" || nextState === "permanent_failed") {
      db.prepare(
        "update transactional_notification_intents set state=?,updated_at=? where notification_id=?",
      ).run(nextState === "delivered_when_known" ? "sent" : "failed", timestamp, delivery.notification_id);
    }
    return { applied: true, deliveryState: nextState };
  })();
}
