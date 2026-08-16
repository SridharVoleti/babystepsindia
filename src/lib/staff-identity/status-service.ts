import { getDb } from "@/lib/db/client";
import { countActivePlatformAdministrators, findStaffById } from "@/lib/staff-identity/accounts-repo";
import type { StaffAccountStatus } from "@/lib/staff-identity/contracts";
import { StaffIdentityError } from "@/lib/staff-identity/errors";
import {
  beginMutationReceipt,
  checkMutationReplay,
  completeMutationReceipt,
  hashMutationPayload,
} from "@/lib/staff-identity/mutation-idempotency";
import { validateSensitiveReason } from "@/lib/staff-identity/reason-validation";
import { recordStaffAuditEvent } from "@/lib/staff-identity/staff-audit-log";

// API-AD-007. Business rules 27-28, 70-73: reversible suspend, one-way
// revoke, self-mutation and last-Platform-Administrator both blocked.
export function changeStaffStatus(input: {
  actorStaffId: string;
  targetStaffId: string;
  newStatus: StaffAccountStatus;
  reason: string;
  expectedVersion: number;
  idempotencyKey: string;
  now?: Date;
}): { staffAccountId: string; status: StaffAccountStatus; version: number } {
  const now = input.now ?? new Date();
  const reason = validateSensitiveReason(input.reason);
  const requestHash = hashMutationPayload({
    targetStaffId: input.targetStaffId,
    newStatus: input.newStatus,
    expectedVersion: input.expectedVersion,
  });
  const replay = checkMutationReplay(input.actorStaffId, input.idempotencyKey, requestHash) as
    | { staffAccountId: string; status: StaffAccountStatus; version: number }
    | undefined;
  if (replay !== undefined) return replay;

  // Business rule 72: a Platform Administrator cannot suspend/revoke (or
  // reinstate) their own account.
  if (input.actorStaffId === input.targetStaffId) throw new StaffIdentityError("SELF_STATUS_CHANGE_BLOCKED");

  const target = findStaffById(input.targetStaffId);
  if (!target) throw new StaffIdentityError("RESOURCE_NOT_FOUND");
  if (target.version !== input.expectedVersion) throw new StaffIdentityError("VERSION_CONFLICT");
  // Business rule 28: revoked is a one-way terminal state.
  if (target.status === "revoked") throw new StaffIdentityError("STAFF_ACCOUNT_REVOKED");

  if (["suspended", "revoked"].includes(input.newStatus)) {
    const isPlatformAdmin = getDb()
      .prepare(
        "select 1 from staff_role_assignments where staff_account_id=? and role_key='platform_administrator' and removed_at is null",
      )
      .get(input.targetStaffId);
    if (isPlatformAdmin && countActivePlatformAdministrators(input.targetStaffId) === 0) {
      throw new StaffIdentityError("LAST_PLATFORM_ADMINISTRATOR");
    }
  }

  const db = getDb();
  const timestamp = now.toISOString();
  const response = db.transaction(() => {
    beginMutationReceipt({
      actorStaffAccountId: input.actorStaffId,
      idempotencyKey: input.idempotencyKey,
      canonicalAction: "admin.staff.status.update",
      targetStaffAccountId: input.targetStaffId,
      requestHash,
      now,
    });
    const statusTimestampColumn =
      input.newStatus === "suspended" ? "suspended_at" : input.newStatus === "revoked" ? "revoked_at" : null;
    if (statusTimestampColumn) {
      db.prepare(
        `update staff_accounts set status=?, authorization_generation=authorization_generation+1,
         version=version+1, updated_at=?, ${statusTimestampColumn}=? where id=?`,
      ).run(input.newStatus, timestamp, timestamp, input.targetStaffId);
    } else {
      db.prepare(
        `update staff_accounts set status=?, authorization_generation=authorization_generation+1,
         version=version+1, updated_at=? where id=?`,
      ).run(input.newStatus, timestamp, input.targetStaffId);
    }
    const updated = findStaffById(input.targetStaffId)!;
    recordStaffAuditEvent({
      actorStaffAccountId: input.actorStaffId,
      targetStaffAccountId: input.targetStaffId,
      canonicalAction: "admin.staff.status.update",
      resourceType: "staff",
      resourceSafeId: input.targetStaffId,
      reason,
      result: "success",
      now,
    });
    const result = { staffAccountId: updated.id, status: updated.status, version: updated.version };
    completeMutationReceipt({ actorStaffAccountId: input.actorStaffId, idempotencyKey: input.idempotencyKey, response: result, now });
    return result;
  })();
  return response;
}
