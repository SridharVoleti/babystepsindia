import { NextResponse } from "next/server";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";
import { ingestDeploymentWebhook } from "@/lib/deployment-webhook/service";

// AR-002 session 2, business rule 37 + PRG-024: provider webhooks require signature verification, timestamp tolerance, payload
// validation, event-ID idempotency, and replay rejection. Authenticated by its own HMAC signature over the raw request body
// (DEPLOYMENT_WEBHOOK_SECRET) rather than the internal-service-assertion pattern used by src/lib/auth/internal-service-guard.ts -
// a deployment provider isn't a Babysteps-issued managed service principal. The signature is verified BEFORE the payload is parsed.
export async function POST(request: Request) {
  const signature = request.headers.get("x-babysteps-webhook-signature") ?? "";
  const timestampHeader = request.headers.get("x-babysteps-webhook-timestamp") ?? "";
  const rawBody = await request.text();

  const secret = process.env.DEPLOYMENT_WEBHOOK_SECRET ?? "";
  if (secret.length < 32) return NextResponse.json({ error: "WEBHOOK_SIGNATURE_INVALID" }, { status: 401 });

  try {
    const receipt = await ingestDeploymentWebhook({
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
