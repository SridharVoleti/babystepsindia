import { createHash } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { StaffIdentityError } from "@/lib/staff-identity/errors";

// Same request_hash + idempotency_key composite pattern BI-001 uses
// (subscription_reassignment_requests) for a PATCH/PUT-shaped mutation
// against an existing entity rather than a create.
export function hashMutationPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function findMutationReceipt(actorStaffAccountId: string, idempotencyKey: string) {
  return getDb()
    .prepare(
      "select request_hash,status,response_json from staff_mutation_requests where actor_staff_account_id=? and idempotency_key=?",
    )
    .get(actorStaffAccountId, idempotencyKey) as
    | { request_hash: string; status: string; response_json: string | null }
    | undefined;
}

export function beginMutationReceipt(input: {
  actorStaffAccountId: string;
  idempotencyKey: string;
  canonicalAction: string;
  targetStaffAccountId: string;
  requestHash: string;
  now: Date;
}) {
  getDb()
    .prepare(
      `insert into staff_mutation_requests
       (actor_staff_account_id,idempotency_key,canonical_action,target_staff_account_id,request_hash,status,created_at)
       values (?,?,?,?,?,'processing',?)`,
    )
    .run(
      input.actorStaffAccountId,
      input.idempotencyKey,
      input.canonicalAction,
      input.targetStaffAccountId,
      input.requestHash,
      input.now.toISOString(),
    );
}

export function completeMutationReceipt(input: {
  actorStaffAccountId: string;
  idempotencyKey: string;
  response: unknown;
  now: Date;
}) {
  getDb()
    .prepare(
      "update staff_mutation_requests set status='completed',response_json=?,completed_at=? where actor_staff_account_id=? and idempotency_key=?",
    )
    .run(JSON.stringify(input.response), input.now.toISOString(), input.actorStaffAccountId, input.idempotencyKey);
}

// Returns a cached response for a genuine replay, throws on a reused key
// with a different payload, or returns undefined for a fresh request.
export function checkMutationReplay(
  actorStaffAccountId: string,
  idempotencyKey: string,
  requestHash: string,
): unknown | undefined {
  const receipt = findMutationReceipt(actorStaffAccountId, idempotencyKey);
  if (!receipt) return undefined;
  if (receipt.request_hash !== requestHash) throw new StaffIdentityError("IDEMPOTENCY_KEY_REUSED");
  return receipt.response_json ? JSON.parse(receipt.response_json) : undefined;
}
