import { createHash } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { clearLauncherAccessCache } from "@/lib/entitlement-access/launcher-cache";
import { computeLauncherSourceVersionHash } from "./service";

const SOURCE_TYPES = new Set([
  "entitlement", "credit", "session", "progress_summary", "app_metadata", "deployment",
  "security", "availability", "achievement", "consistency", "checkout",
]);

export class LauncherFreshnessError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "LauncherFreshnessError"; }
}

export type LauncherInvalidationInput = {
  learnerId: string;
  appId?: string;
  environment: string;
  sourceType: string;
  sourceVersion: string | number;
  eventId: string;
};

export type LauncherReconciliationInput = {
  learnerId?: string;
  appId?: string;
  environment: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit: number;
  runIdempotencyKey: string;
};

type ReceiptRow = { request_hash: string; response_json: string | null; status: string };

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function assertIdentifier(value: string, code = "INVALID_REQUEST") {
  if (!value.trim() || value.length > 200) throw new LauncherFreshnessError(code);
}

async function receipt(tx: DbClient, principalId: string, action: "invalidate" | "reconcile", idempotencyKey: string) {
  return tx.get<ReceiptRow>(`select request_hash,response_json,status from learner_launcher_freshness_receipts
    where principal_id=? and action=? and idempotency_key=?`, [principalId, action, idempotencyKey]);
}

async function beginReceipt(tx: DbClient, principalId: string, action: "invalidate" | "reconcile", idempotencyKey: string,
  requestHash: string, now: Date) {
  const existing = await receipt(tx, principalId, action, idempotencyKey);
  if (existing) {
    if (existing.request_hash !== requestHash) throw new LauncherFreshnessError("IDEMPOTENCY_KEY_REUSED");
    if (existing.status !== "completed" || !existing.response_json) throw new LauncherFreshnessError("REQUEST_IN_PROGRESS");
    return JSON.parse(existing.response_json) as Record<string, unknown>;
  }
  await tx.run(`insert into learner_launcher_freshness_receipts
    (principal_id,action,idempotency_key,request_hash,status,created_at) values(?,?,?,?,'processing',?)`,
    [principalId, action, idempotencyKey, requestHash, now.toISOString()]);
  return null;
}

async function completeReceipt(tx: DbClient, principalId: string, action: "invalidate" | "reconcile", idempotencyKey: string,
  result: Record<string, unknown>, now: Date) {
  await tx.run(`update learner_launcher_freshness_receipts set status='completed',response_json=?,completed_at=?
    where principal_id=? and action=? and idempotency_key=?`,
    [JSON.stringify(result), now.toISOString(), principalId, action, idempotencyKey]);
  return result;
}

async function assertScope(tx: DbClient, learnerId: string, appId?: string) {
  if (!(await tx.get("select 1 from learners where id=?", [learnerId]))) {
    throw new LauncherFreshnessError("RESOURCE_NOT_FOUND");
  }
  if (appId && !(await tx.get("select 1 from app_registry where id=?", [appId]))) {
    throw new LauncherFreshnessError("RESOURCE_NOT_FOUND");
  }
}

export async function invalidateLauncherFreshness(principalId: string, input: LauncherInvalidationInput, now: Date) {
  assertIdentifier(input.learnerId);
  assertIdentifier(input.environment);
  assertIdentifier(input.eventId);
  if (input.appId !== undefined) assertIdentifier(input.appId);
  if (!SOURCE_TYPES.has(input.sourceType)) throw new LauncherFreshnessError("SOURCE_TYPE_INVALID");
  const sourceVersion = String(input.sourceVersion);
  assertIdentifier(sourceVersion, "SOURCE_VERSION_INVALID");
  const requestHash = digest({ ...input, sourceVersion });

  return resolveDbClient().transaction(async (tx) => {
    const replay = await beginReceipt(tx, principalId, "invalidate", input.eventId, requestHash, now);
    if (replay) return replay;
    await assertScope(tx, input.learnerId, input.appId);
    const existing = await tx.get<
      { invalidation_version: number; source_type: string | null; source_version: string | null; app_id: string | null }
    >(`select invalidation_version,source_type,source_version,app_id
      from launcher_freshness_metadata where learner_id=? and environment=?`,
      [input.learnerId, input.environment]);
    if (existing?.source_type === input.sourceType && existing.app_id === (input.appId ?? null)
      && /^\d+$/.test(existing.source_version ?? "") && /^\d+$/.test(sourceVersion)
      && BigInt(sourceVersion) < BigInt(existing.source_version!)) {
      throw new LauncherFreshnessError("SOURCE_VERSION_CONFLICT");
    }
    const timestamp = now.toISOString();
    await tx.run(`insert into launcher_freshness_metadata
      (learner_id,environment,invalidation_version,invalidated_at,invalidation_reason,source_type,source_version,
       source_event_id,app_id,created_at,updated_at)
      values(?,?,1,?,?,?,?,?,?,?,?)
      on conflict(learner_id,environment) do update set
       invalidation_version=launcher_freshness_metadata.invalidation_version+1,
       invalidated_at=excluded.invalidated_at,invalidation_reason=excluded.invalidation_reason,
       source_type=excluded.source_type,source_version=excluded.source_version,
       source_event_id=excluded.source_event_id,app_id=excluded.app_id,
       version=launcher_freshness_metadata.version+1,updated_at=excluded.updated_at`,
      [input.learnerId, input.environment, timestamp, input.sourceType, input.sourceType, sourceVersion,
        input.eventId, input.appId ?? null, timestamp, timestamp]);
    const row = await tx.get<{ invalidation_version: number; version: number }>(
      `select invalidation_version,version from launcher_freshness_metadata
      where learner_id=? and environment=?`, [input.learnerId, input.environment]);
    clearLauncherAccessCache();
    return completeReceipt(tx, principalId, "invalidate", input.eventId, {
      accepted: true, learnerId: input.learnerId, appId: input.appId ?? null, environment: input.environment,
      sourceType: input.sourceType, sourceVersion, eventId: input.eventId,
      invalidationVersion: row!.invalidation_version, freshnessVersion: row!.version,
    }, now);
  });
}

async function scopedLearnerIds(tx: DbClient, input: LauncherReconciliationInput) {
  if (input.learnerId) {
    await assertScope(tx, input.learnerId, input.appId);
    return [input.learnerId];
  }
  const conditions = ["m.environment=?"];
  const params: unknown[] = [input.environment];
  if (input.cursor) { conditions.push("m.learner_id>?"); params.push(input.cursor); }
  if (input.from) { conditions.push("m.updated_at>=?"); params.push(input.from); }
  if (input.to) { conditions.push("m.updated_at<?"); params.push(input.to); }
  if (input.appId) { conditions.push("m.app_id=?"); params.push(input.appId); }
  params.push(input.limit + 1);
  return (await tx.all<{ learner_id: string }>(`select learner_id from launcher_freshness_metadata m where ${conditions.join(" and ")}
    order by learner_id limit ?`, params as (string | number)[])).map((row) => row.learner_id);
}

export async function reconcileLauncherFreshness(principalId: string, input: LauncherReconciliationInput, now: Date) {
  assertIdentifier(input.environment);
  assertIdentifier(input.runIdempotencyKey);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new LauncherFreshnessError("INVALID_REQUEST");
  }
  const requestHash = digest(input);
  return resolveDbClient().transaction(async (tx) => {
    const replay = await beginReceipt(tx, principalId, "reconcile", input.runIdempotencyKey, requestHash, now);
    if (replay) return replay;
    const ids = await scopedLearnerIds(tx, input);
    const hasMore = ids.length > input.limit;
    const page = ids.slice(0, input.limit);
    let healthy = 0; let repaired = 0; let stale = 0; let errors = 0;
    for (const learnerId of page) {
      try {
        const sourceVersionHash = await computeLauncherSourceVersionHash(learnerId, input.environment);
        const current = await tx.get<
          { source_version_hash: string | null; invalidated_at: string | null; next_recheck_at: string | null }
        >(`select source_version_hash,invalidated_at,next_recheck_at
          from launcher_freshness_metadata where learner_id=? and environment=?`, [learnerId, input.environment]);
        const boundaryStale = !!current?.next_recheck_at && current.next_recheck_at <= now.toISOString();
        if (current && current.source_version_hash === sourceVersionHash && !current.invalidated_at && !boundaryStale) {
          healthy += 1;
          continue;
        }
        if (current?.invalidated_at || boundaryStale) stale += 1;
        const timestamp = now.toISOString();
        await tx.run(`insert into launcher_freshness_metadata
          (learner_id,environment,source_version_hash,created_at,updated_at,last_successful_refresh_at,last_refresh_result)
          values(?,?,?,?,?,?,'reconciled')
          on conflict(learner_id,environment) do update set source_version_hash=excluded.source_version_hash,
           invalidated_at=null,invalidation_reason=null,source_event_id=null,
           next_recheck_at=case when launcher_freshness_metadata.next_recheck_at<=excluded.updated_at then null
             else launcher_freshness_metadata.next_recheck_at end,
           last_successful_refresh_at=excluded.last_successful_refresh_at,last_refresh_result='reconciled',
           version=launcher_freshness_metadata.version+1,updated_at=excluded.updated_at`,
          [learnerId, input.environment, sourceVersionHash, timestamp, timestamp, timestamp]);
        repaired += 1;
      } catch {
        errors += 1;
      }
    }
    clearLauncherAccessCache();
    return completeReceipt(tx, principalId, "reconcile", input.runIdempotencyKey, {
      healthy, repaired, stale, errors, nextCursor: hasMore ? page.at(-1) ?? null : null,
    }, now);
  });
}

export function launcherFreshnessErrorStatus(code: string) {
  if (code === "RESOURCE_NOT_FOUND") return 404;
  if (["IDEMPOTENCY_KEY_REUSED", "REQUEST_IN_PROGRESS", "SOURCE_VERSION_CONFLICT"].includes(code)) return 409;
  return 400;
}
