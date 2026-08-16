import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { activeRoleKeys, countActivePlatformAdministrators, findStaffById } from "@/lib/staff-identity/accounts-repo";
import { STAFF_ROLE_KEYS, type StaffRoleKey } from "@/lib/staff-identity/contracts";
import { StaffIdentityError } from "@/lib/staff-identity/errors";
import {
  beginMutationReceipt,
  checkMutationReplay,
  completeMutationReceipt,
  hashMutationPayload,
} from "@/lib/staff-identity/mutation-idempotency";
import { validateSensitiveReason } from "@/lib/staff-identity/reason-validation";
import { recordStaffAuditEvent } from "@/lib/staff-identity/staff-audit-log";

// API-AD-008. Business rules 31, 33, 70-71, 73: server-side, explicit,
// replaces the full active-role set; self-escalation and removing the
// last Platform Administrator are both blocked.
export function assignStaffRoles(input: {
  actorStaffId: string;
  targetStaffId: string;
  roleKeys: StaffRoleKey[];
  reason: string;
  expectedVersion: number;
  idempotencyKey: string;
  now?: Date;
}): { staffAccountId: string; roleKeys: StaffRoleKey[]; version: number } {
  const now = input.now ?? new Date();
  const reason = validateSensitiveReason(input.reason);
  const uniqueRoles = Array.from(new Set(input.roleKeys));
  if (uniqueRoles.some((key) => !STAFF_ROLE_KEYS.includes(key))) throw new StaffIdentityError("INVALID_ROLE_KEY");

  const requestHash = hashMutationPayload({ targetStaffId: input.targetStaffId, roleKeys: [...uniqueRoles].sort(), expectedVersion: input.expectedVersion });
  const replay = checkMutationReplay(input.actorStaffId, input.idempotencyKey, requestHash) as
    | { staffAccountId: string; roleKeys: StaffRoleKey[]; version: number }
    | undefined;
  if (replay !== undefined) return replay;

  // Business rule 71: a Platform Administrator cannot add/remove roles on
  // their own account.
  if (input.actorStaffId === input.targetStaffId) throw new StaffIdentityError("SELF_ESCALATION_BLOCKED");

  const target = findStaffById(input.targetStaffId);
  if (!target) throw new StaffIdentityError("RESOURCE_NOT_FOUND");
  if (target.version !== input.expectedVersion) throw new StaffIdentityError("VERSION_CONFLICT");
  if (target.status === "revoked") throw new StaffIdentityError("STAFF_ACCOUNT_REVOKED");

  const current = new Set(activeRoleKeys(input.targetStaffId));
  const losingPlatformAdmin = current.has("platform_administrator") && !uniqueRoles.includes("platform_administrator");
  if (losingPlatformAdmin && countActivePlatformAdministrators(input.targetStaffId) === 0) {
    throw new StaffIdentityError("LAST_PLATFORM_ADMINISTRATOR");
  }

  const db = getDb();
  const timestamp = now.toISOString();
  const response = db.transaction(() => {
    beginMutationReceipt({
      actorStaffAccountId: input.actorStaffId,
      idempotencyKey: input.idempotencyKey,
      canonicalAction: "admin.staff.roles.update",
      targetStaffAccountId: input.targetStaffId,
      requestHash,
      now,
    });
    // Business rule 33: one active assignment per (staff, role) —
    // replace the whole set rather than diffing, simplest correct model.
    db.prepare("update staff_role_assignments set removed_at=? where staff_account_id=? and removed_at is null")
      .run(timestamp, input.targetStaffId);
    for (const roleKey of uniqueRoles) {
      db.prepare(
        "insert into staff_role_assignments (id,staff_account_id,role_key,assigned_by_staff_id,assigned_at) values (?,?,?,?,?)",
      ).run(randomUUID(), input.targetStaffId, roleKey, input.actorStaffId, timestamp);
    }
    db.prepare(
      "update staff_accounts set authorization_generation=authorization_generation+1, version=version+1, updated_at=? where id=?",
    ).run(timestamp, input.targetStaffId);
    const updated = findStaffById(input.targetStaffId)!;
    recordStaffAuditEvent({
      actorStaffAccountId: input.actorStaffId,
      targetStaffAccountId: input.targetStaffId,
      canonicalAction: "admin.staff.roles.update",
      resourceType: "staff",
      resourceSafeId: input.targetStaffId,
      reason,
      result: "success",
      now,
    });
    const result = { staffAccountId: updated.id, roleKeys: uniqueRoles, version: updated.version };
    completeMutationReceipt({ actorStaffAccountId: input.actorStaffId, idempotencyKey: input.idempotencyKey, response: result, now });
    return result;
  })();
  return response;
}
