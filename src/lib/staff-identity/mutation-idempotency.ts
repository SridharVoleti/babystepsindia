import { createHash } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import { StaffIdentityError } from "@/lib/staff-identity/errors";

// Same request_hash + idempotency_key composite pattern BI-001 uses
// (subscription_reassignment_requests) for a PATCH/PUT-shaped mutation
// against an existing entity rather than a create.
export function hashMutationPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function findMutationReceipt(actorStaffAccountId: string, idempotencyKey: string) {
  return resolveDbClient().get<{ request_hash: string; status: string; response_json: string | null }>(
    "select request_hash,status,response_json from staff_mutation_requests where actor_staff_account_id=? and idempotency_key=?",
    [actorStaffAccountId, idempotencyKey],
  );
}

export async function beginMutationReceipt(input: {
  actorStaffAccountId: string;
  idempotencyKey: string;
  canonicalAction: string;
  targetStaffAccountId: string;
  requestHash: string;
  now: Date;
}) {
  await resolveDbClient().run(
    `insert into staff_mutation_requests
     (actor_staff_account_id,idempotency_key,canonical_action,target_staff_account_id,request_hash,status,created_at)
     values (?,?,?,?,?,'processing',?)`,
    [
      input.actorStaffAccountId,
      input.idempotencyKey,
      input.canonicalAction,
      input.targetStaffAccountId,
      input.requestHash,
      input.now.toISOString(),
    ],
  );
}

export async function completeMutationReceipt(input: {
  actorStaffAccountId: string;
  idempotencyKey: string;
  response: unknown;
  now: Date;
}) {
  await resolveDbClient().run(
    "update staff_mutation_requests set status='completed',response_json=?,completed_at=? where actor_staff_account_id=? and idempotency_key=?",
    [JSON.stringify(input.response), input.now.toISOString(), input.actorStaffAccountId, input.idempotencyKey],
  );
}

// Returns a cached response for a genuine replay, throws on a reused key
// with a different payload, or returns undefined for a fresh request.
export async function checkMutationReplay(
  actorStaffAccountId: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<unknown | undefined> {
  const receipt = await findMutationReceipt(actorStaffAccountId, idempotencyKey);
  if (!receipt) return undefined;
  if (receipt.request_hash !== requestHash) throw new StaffIdentityError("IDEMPOTENCY_KEY_REUSED");
  return receipt.response_json ? JSON.parse(receipt.response_json) : undefined;
}
