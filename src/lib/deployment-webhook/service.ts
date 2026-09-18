import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";

// AR-002 session 2, business rules 37, 40, AC30-31: signed, idempotent,
// replay-rejecting webhook ingestion. Per rule 44 ("no repository/app
// credential may mutate publication pointers directly"), this is
// deliberately audit-only — recording a verified event is all it does; it
// never itself triggers promote/rollback/publish (those stay owned by
// deployment-production/service.ts and deployment-rollback/service.ts,
// gated by admin permission/reauth or the release-safety sweep).
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

export type IngestWebhookInput = {
  provider: string;
  providerEventId: string;
  timestampSeconds: number;
  signatureHex: string;
  rawBody: string;
  secret: string;
  now: Date;
};

export type WebhookReceiptView = { id: string; provider: string; providerEventId: string; status: "processed" };

export async function ingestDeploymentWebhook(input: IngestWebhookInput): Promise<WebhookReceiptView> {
  if (!Number.isFinite(input.timestampSeconds)) throw new DeploymentPipelineError("WEBHOOK_SIGNATURE_INVALID");
  const skewMs = Math.abs(input.now.getTime() - input.timestampSeconds * 1000);
  if (skewMs > TIMESTAMP_TOLERANCE_MS) throw new DeploymentPipelineError("WEBHOOK_SIGNATURE_INVALID");

  const expectedSignature = createHmac("sha256", input.secret).update(`${input.timestampSeconds}.${input.rawBody}`).digest("hex");
  if (!safeEqual(expectedSignature, input.signatureHex)) throw new DeploymentPipelineError("WEBHOOK_SIGNATURE_INVALID");

  const db = resolveDbClient();
  const existing = await db.get(
    "select 1 from deployment_webhook_receipts where provider = ? and provider_event_id = ?",
    [input.provider, input.providerEventId],
  );
  if (existing) throw new DeploymentPipelineError("WEBHOOK_REPLAYED");

  const id = randomUUID();
  const nowIso = input.now.toISOString();
  await db.run(
    "insert into deployment_webhook_receipts (id, provider, provider_event_id, received_at, processed_at, status) values (?, ?, ?, ?, ?, 'processed')",
    [id, input.provider, input.providerEventId, nowIso, nowIso],
  );

  return { id, provider: input.provider, providerEventId: input.providerEventId, status: "processed" };
}
