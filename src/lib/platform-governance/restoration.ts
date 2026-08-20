import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { restoreAccount } from "@/lib/db/account-security-repo";
import { recordStaffAuditEvent } from "@/lib/staff-identity/staff-audit-log";
import { PlatformGovernanceError, isValidGovernanceReason } from "@/lib/platform-governance/contracts";
import {
  beginGovernanceMutationReceipt, checkGovernanceMutationReplay, completeGovernanceMutationReceipt, hashMutationPayload,
} from "@/lib/platform-governance/mutation-idempotency";

type StaffCaller = { staffAccountId: string; roleKeys: readonly string[] };

export type RestoreParentInput = {
  parentId: string;
  reason: string;
  expectedVersion: number;
  idempotencyKey: string;
  caseId?: string;
  governanceReference?: string;
  now?: Date;
};

// API-AD-031. Rules 71-78: IA-003's restoreAccount remains the sole
// restoration authority — this only adds the governance envelope the
// frozen contract requires around it (exact reference, reauth already
// checked by the route, expectedVersion, idempotency) and never edits
// email/password/phone/learner/subscription/progress/credit state itself.
export async function restoreAccountViaGovernance(actor: StaffCaller, input: RestoreParentInput) {
  const now = input.now ?? new Date();
  const reason = input.reason.trim();
  if (!isValidGovernanceReason(reason)) throw new PlatformGovernanceError("INVALID_REASON");
  if (!input.caseId && !input.governanceReference) throw new PlatformGovernanceError("INVALID_REQUEST");

  const requestHash = hashMutationPayload({
    parentId: input.parentId, expectedVersion: input.expectedVersion,
    caseId: input.caseId ?? null, governanceReference: input.governanceReference ?? null,
  });
  const replay = checkGovernanceMutationReplay(actor.staffAccountId, input.idempotencyKey, requestHash) as
    | { parentId: string; version: number }
    | undefined;
  if (replay !== undefined) return replay;

  const db = resolveDbClient();
  if (input.caseId) {
    const kase = await db.get<{ id: string }>("select id from support_cases where id=?", [input.caseId]);
    if (!kase) throw new PlatformGovernanceError("INVALID_REQUEST");
  }

  const profile = await db.get<{ account_status: string; version: number }>(
    "select account_status, version from profiles where id=?", [input.parentId]);
  if (!profile) throw new PlatformGovernanceError("PARENT_NOT_FOUND");
  if (profile.version !== input.expectedVersion) throw new PlatformGovernanceError("VERSION_CONFLICT");
  // Rule 76: IA-003 eligibility for this action is simply "there is
  // something to restore" — only a soft-deleted account is restorable.
  if (profile.account_status !== "deleted") throw new PlatformGovernanceError("ACCOUNT_NOT_ELIGIBLE");

  const timestamp = now.toISOString();
  return resolveDbClient().transaction(async (tx: DbClient) => {
    beginGovernanceMutationReceipt({
      actorStaffAccountId: actor.staffAccountId, idempotencyKey: input.idempotencyKey,
      canonicalAction: "admin.platform.parent_restoration.create", targetReference: input.parentId,
      requestHash, now,
    });
    await tx.run("update profiles set version=version+1, updated_at=? where id=?", [timestamp, input.parentId]);
    await restoreAccount(input.parentId, actor.staffAccountId, `${reason} [${input.caseId ? `case:${input.caseId}` : `governance:${input.governanceReference}`}]`);
    await recordStaffAuditEvent({
      actorStaffAccountId: actor.staffAccountId, targetStaffAccountId: null,
      canonicalAction: "admin.platform.parent_restoration.create", resourceType: "parent", resourceSafeId: input.parentId,
      reason, result: "success", now,
    });
    const result = { parentId: input.parentId, version: input.expectedVersion + 1 };
    completeGovernanceMutationReceipt({ actorStaffAccountId: actor.staffAccountId, idempotencyKey: input.idempotencyKey, response: result, now });
    return result;
  });
}
