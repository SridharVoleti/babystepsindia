import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";

// AR-002 session 2 (business rules 37, 40, AC30-31) + PRG-024: signed, validated, idempotent, replay-rejecting webhook processing.
//
// The webhook is authoritative for PROVIDER-OBSERVED build state only: it can move a deployment that is still in flight
// (deploying -> validating on "ready", deploying/validating -> failed on error/cancel). It can never publish, supersede or
// roll back a deployment and never touches the publication pointer (rule 44): those stay owned by deployment-production /
// deployment-rollback, gated by admin permission/reauth or the release-safety sweep. Every event is recorded in the
// append-only app_deployment_events history, linked to its provider receipt.
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
const SUPPORTED_PROVIDERS = new Set(["vercel"]);
const MAX_ID_LENGTH = 200;

export type DeploymentStatus = "deploying" | "validating" | "published" | "superseded" | "failed" | "rolled_back";

/** Provider event -> target state. Events not listed here are acknowledged and recorded but ignored. */
const EVENT_TARGET: Record<string, DeploymentStatus> = {
  "deployment.created": "deploying",
  "deployment.building": "deploying",
  "deployment.ready": "validating",
  "deployment.error": "failed",
  "deployment.canceled": "failed",
};

/** Legal provider-driven transitions; everything else (including any move out of a terminal/published state) is refused. */
const LEGAL: Record<string, readonly DeploymentStatus[]> = {
  deploying: ["validating", "failed"],
  validating: ["failed"],
};

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

export type DeploymentWebhookPayload = { provider: string; eventId: string; type: string; deploymentId: string };

export function parseDeploymentWebhookPayload(rawBody: string): DeploymentWebhookPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new DeploymentPipelineError("INVALID_BODY");
  }
  const p = payload as { provider?: unknown; eventId?: unknown; type?: unknown; deployment?: { id?: unknown } | null };
  const bounded = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;
  if (!p || typeof p !== "object" || !bounded(p.provider) || !bounded(p.eventId) || !bounded(p.type) || !p.deployment || typeof p.deployment !== "object" || !bounded(p.deployment.id)) {
    throw new DeploymentPipelineError("INVALID_REQUEST");
  }
  if (!SUPPORTED_PROVIDERS.has(p.provider)) throw new DeploymentPipelineError("INVALID_REQUEST");
  return { provider: p.provider, eventId: p.eventId, type: p.type, deploymentId: p.deployment.id };
}

export type IngestWebhookInput = {
  timestampSeconds: number;
  signatureHex: string;
  rawBody: string;
  secret: string;
  now: Date;
};

export type WebhookTransition = { deploymentId: string; from: DeploymentStatus; to: DeploymentStatus };
export type WebhookOutcome = "applied" | "no_change" | "ignored_unsafe_transition" | "ignored_unsupported_event" | "no_matching_deployment";
export type WebhookReceiptView = {
  id: string; provider: string; providerEventId: string; status: "processed"; eventType: string; outcome: WebhookOutcome; transitions: WebhookTransition[];
};

type DeploymentRow = { id: string; status: DeploymentStatus };

async function recordEvent(tx: DbClient, args: {
  deploymentId: string; receiptId: string; provider: string; eventId: string; eventType: string; from: string; to: string; applied: boolean; at: string;
}) {
  await tx.run(
    `insert into app_deployment_events (id, deployment_id, receipt_id, provider, provider_event_id, event_type, from_status, to_status, applied, received_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomUUID(), args.deploymentId, args.receiptId, args.provider, args.eventId, args.eventType, args.from, args.to, args.applied ? 1 : 0, args.at],
  );
}

// In-process serialisation: the SQLite dev/test adapter shares one connection, so concurrent async transactions on it can interleave.
// (Postgres is protected by its transaction + the unique (provider, event id) constraint; this only removes the single-connection hazard.)
let ingestChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = ingestChain.then(fn, fn);
  ingestChain = run.catch(() => undefined);
  return run;
}

export async function ingestDeploymentWebhook(input: IngestWebhookInput): Promise<WebhookReceiptView> {
  // Verification and validation are cheap and stateless; only the stateful part is serialised.
  return verifyAndParse(input, (event, payloadSha256, nowIso) => serialized(() => processEvent(event, payloadSha256, nowIso)));
}

async function verifyAndParse<T>(input: IngestWebhookInput, next: (event: DeploymentWebhookPayload, payloadSha256: string, nowIso: string) => Promise<T>): Promise<T> {
  // 1. Authenticity first: nothing about the payload is trusted until the signature and timestamp verify.
  if (!Number.isFinite(input.timestampSeconds)) throw new DeploymentPipelineError("WEBHOOK_SIGNATURE_INVALID");
  const skewMs = Math.abs(input.now.getTime() - input.timestampSeconds * 1000);
  if (skewMs > TIMESTAMP_TOLERANCE_MS) throw new DeploymentPipelineError("WEBHOOK_SIGNATURE_INVALID");
  const expectedSignature = createHmac("sha256", input.secret).update(`${input.timestampSeconds}.${input.rawBody}`).digest("hex");
  if (!safeEqual(expectedSignature, input.signatureHex)) throw new DeploymentPipelineError("WEBHOOK_SIGNATURE_INVALID");

  // 2. Payload validation (no receipt is written for a malformed payload).
  const event = parseDeploymentWebhookPayload(input.rawBody);
  return next(event, createHash("sha256").update(input.rawBody).digest("hex"), input.now.toISOString());
}

async function processEvent(event: DeploymentWebhookPayload, payloadSha256: string, nowIso: string): Promise<WebhookReceiptView> {
  const db = resolveDbClient();

  // 3. Idempotent + replay-safe processing in ONE transaction: the receipt (unique per provider/event) and every state change commit together.
  try {
    return await db.transaction(async (tx) => {
      const existing = await tx.get("select 1 from deployment_webhook_receipts where provider = ? and provider_event_id = ?", [event.provider, event.eventId]);
      if (existing) throw new DeploymentPipelineError("WEBHOOK_REPLAYED");

      const receiptId = randomUUID();
      await tx.run(
        "insert into deployment_webhook_receipts (id, provider, provider_event_id, received_at, processed_at, status, event_type, payload_sha256) values (?, ?, ?, ?, ?, 'processed', ?, ?)",
        [receiptId, event.provider, event.eventId, nowIso, nowIso, event.type, payloadSha256],
      );

      const target = EVENT_TARGET[event.type];
      const view = (outcome: WebhookOutcome, transitions: WebhookTransition[]): WebhookReceiptView => ({
        id: receiptId, provider: event.provider, providerEventId: event.eventId, status: "processed", eventType: event.type, outcome, transitions,
      });
      const finish = async (outcome: WebhookOutcome, transitions: WebhookTransition[]) => {
        await tx.run("update deployment_webhook_receipts set outcome = ? where id = ?", [outcome, receiptId]);
        return view(outcome, transitions);
      };
      if (!target) return finish("ignored_unsupported_event", []);

      // The production row stores the provider id with a "::production" suffix (deployment-production/service.ts).
      const rows = await tx.all<DeploymentRow>(
        "select id, status from app_deployments where provider_deployment_id = ? or provider_deployment_id = ? order by started_at, id",
        [event.deploymentId, `${event.deploymentId}::production`],
      );
      if (rows.length === 0) return finish("no_matching_deployment", []);

      const transitions: WebhookTransition[] = [];
      let anyRefused = false;
      let anyAlreadyThere = false;
      for (const row of rows) {
        if (row.status === target) {
          anyAlreadyThere = true;
          await recordEvent(tx, { deploymentId: row.id, receiptId, provider: event.provider, eventId: event.eventId, eventType: event.type, from: row.status, to: target, applied: false, at: nowIso });
          continue;
        }
        const legal = LEGAL[row.status]?.includes(target) ?? false;
        if (!legal) {
          anyRefused = true;
          await recordEvent(tx, { deploymentId: row.id, receiptId, provider: event.provider, eventId: event.eventId, eventType: event.type, from: row.status, to: target, applied: false, at: nowIso });
          continue;
        }
        // Compare-and-set on the observed status so a concurrent pipeline step is never overwritten.
        const changed = await tx.run(
          target === "failed" ? "update app_deployments set status = ?, ended_at = ? where id = ? and status = ?" : "update app_deployments set status = ? where id = ? and status = ?",
          target === "failed" ? [target, nowIso, row.id, row.status] : [target, row.id, row.status],
        );
        const applied = changed.changes === 1;
        if (applied) transitions.push({ deploymentId: row.id, from: row.status, to: target });
        else anyRefused = true;
        await recordEvent(tx, { deploymentId: row.id, receiptId, provider: event.provider, eventId: event.eventId, eventType: event.type, from: row.status, to: target, applied, at: nowIso });
      }
      if (transitions.length === 0 && anyRefused) return finish("ignored_unsafe_transition", transitions);
      if (transitions.length === 0 && anyAlreadyThere) return finish("no_change", transitions);
      return finish("applied", transitions);
    });
  } catch (error) {
    if (error instanceof DeploymentPipelineError) throw error;
    if (/unique|duplicate/i.test(error instanceof Error ? error.message : String(error))) throw new DeploymentPipelineError("WEBHOOK_REPLAYED");
    // A concurrent identical delivery may have won the unique (provider, event id) race.
    const raced = await db.get("select 1 from deployment_webhook_receipts where provider = ? and provider_event_id = ?", [event.provider, event.eventId]);
    if (raced) throw new DeploymentPipelineError("WEBHOOK_REPLAYED");
    throw error;
  }
}
