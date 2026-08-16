import { createHash } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { PlatformGovernanceError } from "@/lib/platform-governance/contracts";

// Same request_hash + idempotency_key composite pattern as
// src/lib/staff-identity/mutation-idempotency.ts, kept as its own module
// against platform_governance_mutation_requests because one of AD-005's
// three write actions (parent restoration) targets a parent, not a staff
// account, and can't use staff_mutation_requests' staff-only target FK.
export function hashMutationPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function beginGovernanceMutationReceipt(input: {
  actorStaffAccountId: string;
  idempotencyKey: string;
  canonicalAction: string;
  targetReference: string | null;
  requestHash: string;
  now: Date;
}) {
  getDb()
    .prepare(
      `insert into platform_governance_mutation_requests
       (actor_staff_account_id,idempotency_key,canonical_action,target_reference,request_hash,status,created_at)
       values (?,?,?,?,?,'processing',?)`,
    )
    .run(
      input.actorStaffAccountId,
      input.idempotencyKey,
      input.canonicalAction,
      input.targetReference,
      input.requestHash,
      input.now.toISOString(),
    );
}

export function completeGovernanceMutationReceipt(input: {
  actorStaffAccountId: string;
  idempotencyKey: string;
  response: unknown;
  now: Date;
}) {
  getDb()
    .prepare(
      "update platform_governance_mutation_requests set status='completed',response_json=?,completed_at=? where actor_staff_account_id=? and idempotency_key=?",
    )
    .run(JSON.stringify(input.response), input.now.toISOString(), input.actorStaffAccountId, input.idempotencyKey);
}

export function checkGovernanceMutationReplay(
  actorStaffAccountId: string,
  idempotencyKey: string,
  requestHash: string,
): unknown | undefined {
  const receipt = getDb()
    .prepare(
      "select request_hash,response_json from platform_governance_mutation_requests where actor_staff_account_id=? and idempotency_key=?",
    )
    .get(actorStaffAccountId, idempotencyKey) as { request_hash: string; response_json: string | null } | undefined;
  if (!receipt) return undefined;
  if (receipt.request_hash !== requestHash) throw new PlatformGovernanceError("IDEMPOTENCY_KEY_REUSED");
  return receipt.response_json ? JSON.parse(receipt.response_json) : undefined;
}
