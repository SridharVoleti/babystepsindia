import { createHash } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import { PlatformGovernanceError } from "@/lib/platform-governance/contracts";

// Same request_hash + idempotency_key composite pattern as
// src/lib/staff-identity/mutation-idempotency.ts, kept as its own module
// against platform_governance_mutation_requests because one of AD-005's
// three write actions (parent restoration) targets a parent, not a staff
// account, and can't use staff_mutation_requests' staff-only target FK.
export function hashMutationPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// Callers still inside a legacy synchronous db.transaction() (which can't
// await) must convert that transaction to resolveDbClient().transaction()
// too, rather than calling this un-awaited — begin/complete are meant to
// commit atomically with the mutation they bracket (crash-safety), unlike
// audit-log writes, so they can't simply be deferred to after commit.
export async function beginGovernanceMutationReceipt(input: {
  actorStaffAccountId: string;
  idempotencyKey: string;
  canonicalAction: string;
  targetReference: string | null;
  requestHash: string;
  now: Date;
}) {
  await resolveDbClient().run(
    `insert into platform_governance_mutation_requests
     (actor_staff_account_id,idempotency_key,canonical_action,target_reference,request_hash,status,created_at)
     values (?,?,?,?,?,'processing',?)`,
    [
      input.actorStaffAccountId,
      input.idempotencyKey,
      input.canonicalAction,
      input.targetReference,
      input.requestHash,
      input.now.toISOString(),
    ],
  );
}

export async function completeGovernanceMutationReceipt(input: {
  actorStaffAccountId: string;
  idempotencyKey: string;
  response: unknown;
  now: Date;
}) {
  await resolveDbClient().run(
    "update platform_governance_mutation_requests set status='completed',response_json=?,completed_at=? where actor_staff_account_id=? and idempotency_key=?",
    [JSON.stringify(input.response), input.now.toISOString(), input.actorStaffAccountId, input.idempotencyKey],
  );
}

export async function checkGovernanceMutationReplay(
  actorStaffAccountId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<unknown | undefined> {
  const receipt = await resolveDbClient().get<{ request_hash: string; response_json: string | null }>(
    "select request_hash,response_json from platform_governance_mutation_requests where actor_staff_account_id=? and idempotency_key=?",
    [actorStaffAccountId, idempotencyKey],
  );
  if (!receipt) return undefined;
  if (receipt.request_hash !== requestHash) throw new PlatformGovernanceError("IDEMPOTENCY_KEY_REUSED");
  return receipt.response_json ? JSON.parse(receipt.response_json) : undefined;
}
