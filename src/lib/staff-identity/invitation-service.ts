import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import { hashPassword } from "@/lib/auth/password";
import { normalizeEmail, passwordError } from "@/lib/auth/validation";
import { findStaffByNormalizedEmail } from "@/lib/staff-identity/accounts-repo";
import { INVITATION_TTL_MS, type StaffRoleKey } from "@/lib/staff-identity/contracts";
import { StaffIdentityError } from "@/lib/staff-identity/errors";
import { validateSensitiveReason } from "@/lib/staff-identity/reason-validation";
import { recordStaffAuditEvent } from "@/lib/staff-identity/staff-audit-log";

// Business rule 29: bound to one normalized email, 24h expiry. Business
// rule 1 (API-AD-001 "idempotent"): re-inviting the same still-pending
// email returns the existing invitation rather than creating a second one.
// Business rule 63: staff invitation is itself a sensitive action — the
// caller's reauth is checked by the route guard, the reason recorded here.
export async function createInvitation(input: {
  byStaffId: string;
  email: string;
  initialRoleKeys: StaffRoleKey[];
  reason: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reason = validateSensitiveReason(input.reason);
  const normalized = normalizeEmail(input.email);
  if (!normalized) throw new StaffIdentityError("INVALID_EMAIL");
  if (input.initialRoleKeys.length === 0) throw new StaffIdentityError("ROLE_KEYS_REQUIRED");

  const db = resolveDbClient();
  // Business rule 3: public signup can never create staff — an email
  // already registered as a parent can never be invited as staff either
  // (the mutual-exclusion trigger would reject it at insert time anyway,
  // but reject early here with a clear code rather than a raw DB error).
  const parentConflict = await db.get<{ id: string }>("select id from users where email=?", [normalized]);
  if (parentConflict) {
    const isAlreadyStaff = await db.get("select 1 from staff_accounts where auth_user_id=?", [parentConflict.id]);
    if (!isAlreadyStaff) throw new StaffIdentityError("EMAIL_ALREADY_PARENT");
  }

  const existing = findStaffByNormalizedEmail(normalized);
  if (existing) {
    if (existing.status !== "invited") throw new StaffIdentityError("STAFF_ACCOUNT_ALREADY_EXISTS");
    if (existing.invitation_expires_at && new Date(existing.invitation_expires_at) > now) {
      return { staffAccountId: existing.id, expiresAt: existing.invitation_expires_at };
    }
    // Expired pending invite for the same email: reissue in place.
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS).toISOString();
    await db.run("update staff_accounts set invitation_expires_at=?, updated_at=? where id=?", [
      expiresAt,
      now.toISOString(),
      existing.id,
    ]);
    return { staffAccountId: existing.id, expiresAt };
  }

  const staffId = randomUUID();
  const authUserId = randomUUID();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS).toISOString();
  const timestamp = now.toISOString();

  await db.transaction(async (tx) => {
    // No usable password yet — acceptInvitation sets a real hash. A
    // random placeholder can never verify against any submitted password.
    await tx.run("insert into users (id,email,password_hash,email_verified_at) values (?,?,?,?)", [
      authUserId,
      normalized,
      hashPassword(randomUUID()),
      timestamp,
    ]);
    await tx.run(
      `insert into staff_accounts
       (id,auth_user_id,normalized_email,status,invited_by_staff_id,invitation_expires_at,created_at,updated_at)
       values (?,?,?, 'invited',?,?,?,?)`,
      [staffId, authUserId, normalized, input.byStaffId, expiresAt, timestamp, timestamp],
    );
    for (const roleKey of input.initialRoleKeys) {
      await tx.run(
        "insert into staff_role_assignments (id,staff_account_id,role_key,assigned_by_staff_id,assigned_at) values (?,?,?,?,?)",
        [randomUUID(), staffId, roleKey, input.byStaffId, timestamp],
      );
    }
  });

  await recordStaffAuditEvent({
    actorStaffAccountId: input.byStaffId,
    targetStaffAccountId: staffId,
    canonicalAction: "admin.staff.invitation.create",
    resourceType: "staff",
    resourceSafeId: staffId,
    reason,
    result: "success",
    now,
  });

  return { staffAccountId: staffId, expiresAt };
}

export async function acceptInvitation(input: { staffAccountId: string; password: string; now?: Date }) {
  const now = input.now ?? new Date();
  const error = passwordError(input.password);
  if (error) throw new StaffIdentityError("INVALID_PASSWORD");

  const db = resolveDbClient();
  const staff = await db.get<{ id: string; auth_user_id: string; status: string; invitation_expires_at: string | null }>(
    "select * from staff_accounts where id=?", [input.staffAccountId],
  );
  if (!staff) throw new StaffIdentityError("RESOURCE_NOT_FOUND");
  if (staff.status !== "invited") throw new StaffIdentityError("INVITATION_NOT_PENDING");
  if (!staff.invitation_expires_at || new Date(staff.invitation_expires_at) <= now) {
    throw new StaffIdentityError("INVITATION_EXPIRED");
  }

  const timestamp = now.toISOString();
  await db.transaction(async (tx) => {
    await tx.run("update users set password_hash=?, email_verified_at=? where id=?", [
      hashPassword(input.password),
      timestamp,
      staff.auth_user_id,
    ]);
    // Business rule 26: still can't reach admin APIs until passkey
    // enrollment also completes — status flips to 'active' only once a
    // passkey is registered (see staff-webauthn/staff-service.ts).
    await tx.run("update staff_accounts set status='active', activated_at=?, updated_at=? where id=?", [
      timestamp,
      timestamp,
      staff.id,
    ]);
  });

  return { staffAccountId: staff.id };
}
