import { NextResponse } from "next/server";
import { ingestNotificationProviderEvent, NotificationWebhookError } from "@/lib/notifications/webhook";

// API-NT-003: signed provider callback ingestion. Same header/signature
// shape as /v1/webhooks/financial-events — a provider webhook isn't a
// Babysteps-issued managed service principal, so this is a signature-only
// boundary, not a requireInternalService caller.
export async function POST(request: Request) {
  const signature = request.headers.get("x-babysteps-webhook-signature") ?? "";
  const timestampHeader = request.headers.get("x-babysteps-webhook-timestamp") ?? "";
  const rawBody = await request.text();

  const secret = process.env.NOTIFICATION_PROVIDER_WEBHOOK_SECRET ?? "";
  if (secret.length < 32) return NextResponse.json({ error: "WEBHOOK_AUTHENTICATION_FAILED" }, { status: 401 });

  let payload: Record<string, unknown>;
  try { payload = JSON.parse(rawBody); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const provider = typeof payload.provider === "string" ? payload.provider : "";
  const eventId = typeof payload.eventId === "string" ? payload.eventId : "";
  if (!provider || !eventId) return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });

  try {
    const result = ingestNotificationProviderEvent({
      provider, providerEventId: eventId, timestampSeconds: Number(timestampHeader),
      signatureHex: signature, rawBody, secret, now: new Date(),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof NotificationWebhookError) {
      const status = error.code === "WEBHOOK_REPLAYED" ? 409
        : error.code === "INVALID_REQUEST" ? 400 : 401;
      return NextResponse.json({ error: error.code }, { status, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
