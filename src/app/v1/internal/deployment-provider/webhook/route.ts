import { NextResponse } from "next/server";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";
import { ingestDeploymentWebhook } from "@/lib/deployment-webhook/service";

// AR-002 session 2, business rule 37: provider webhooks require signature
// verification, timestamp tolerance, event-ID idempotency, and replay
// rejection. Authenticated by its own HMAC signature over the raw request
// body (DEPLOYMENT_WEBHOOK_SECRET) rather than the internal-service-
// assertion pattern used by src/lib/auth/internal-service-guard.ts — a
// deployment provider isn't a Babysteps-issued managed service principal.
export async function POST(request: Request) {
  const signature = request.headers.get("x-babysteps-webhook-signature") ?? "";
  const timestampHeader = request.headers.get("x-babysteps-webhook-timestamp") ?? "";
  const rawBody = await request.text();

  const secret = process.env.DEPLOYMENT_WEBHOOK_SECRET ?? "";
  if (secret.length < 32) return NextResponse.json({ error: "WEBHOOK_SIGNATURE_INVALID" }, { status: 401 });

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
    const receipt = ingestDeploymentWebhook({
      provider,
      providerEventId: eventId,
      timestampSeconds: Number(timestampHeader),
      signatureHex: signature,
      rawBody,
      secret,
      now: new Date(),
    });
    return NextResponse.json(receipt);
  } catch (error) {
    if (error instanceof DeploymentPipelineError) {
      return NextResponse.json({ error: error.code }, { status: deploymentPipelineErrorStatus(error.code) });
    }
    throw error;
  }
}
