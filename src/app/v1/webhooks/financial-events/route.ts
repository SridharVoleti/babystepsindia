import { NextResponse } from "next/server";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";
import { ingestFinancialEventWebhook } from "@/lib/billing/bi005-service";

// Minimal BI-005: signed, idempotent, replay-rejecting chargeback/dispute
// ingestion — same HMAC-over-raw-body + timestamp-tolerance shape as
// AR-002's deployment-provider webhook, since a chargeback/dispute source
// isn't a Babysteps-issued managed service principal either.
export async function POST(request: Request) {
  const signature = request.headers.get("x-babysteps-webhook-signature") ?? "";
  const timestampHeader = request.headers.get("x-babysteps-webhook-timestamp") ?? "";
  const rawBody = await request.text();

  const secret = process.env.FINANCIAL_EVENTS_WEBHOOK_SECRET ?? "";
  if (secret.length < 32) return NextResponse.json({ error: "PAYMENT_EVENT_AUTHENTICATION_FAILED" }, { status: 401 });

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const provider = typeof payload.provider === "string" ? payload.provider : "";
  const eventId = typeof payload.eventId === "string" ? payload.eventId : "";
  if (!provider || !eventId) return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });

  try {
    const receipt = await ingestFinancialEventWebhook({
      provider, providerEventId: eventId, timestampSeconds: Number(timestampHeader),
      signatureHex: signature, rawBody, secret, now: new Date(),
    });
    return NextResponse.json(receipt, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BillingAssignmentError) {
      return NextResponse.json({ error: error.code },
        { status: billingAssignmentErrorStatus(error.code), headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
