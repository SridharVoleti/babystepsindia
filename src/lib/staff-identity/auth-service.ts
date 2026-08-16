import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { verifyPassword } from "@/lib/auth/password";
import { normalizeEmail } from "@/lib/auth/validation";
import { activeRoleKeys, findStaffByNormalizedEmail } from "@/lib/staff-identity/accounts-repo";
import { StaffIdentityError } from "@/lib/staff-identity/errors";
import { recordStaffAuditEvent } from "@/lib/staff-identity/staff-audit-log";
import { signPendingStaffToken, signStaffSession, type StaffSessionPayload } from "@/lib/staff-identity/session";
import { activeStaffPasskeyCount } from "@/lib/webauthn/staff-service";

// Business rules 9-11, 20, 26: staff first factor. Never falls back to
// SMS/email-OTP (business rule 18) — the only next step is a passkey
// ceremony, either first-time enrollment (no passkey registered yet) or
// a login assertion.
export async function beginStaffLogin(input: { email: string; password: string; now?: Date }) {
  const now = input.now ?? new Date();
  const normalized = normalizeEmail(input.email);
  const staff = normalized ? findStaffByNormalizedEmail(normalized) : undefined;
  const authUser = staff
    ? (getDb().prepare("select password_hash from users where id=?").get(staff.auth_user_id) as
        | { password_hash: string }
        | undefined)
    : undefined;

  // Deliberately the same generic failure for "no such staff", "wrong
  // password" and "invited, no password set yet" — business rule 101
  // (rate limiting / anti-enumeration), matching the vague-error-at-the-
  // boundary convention this codebase already uses at its parent login.
  if (!staff || !authUser || !verifyPassword(input.password, authUser.password_hash)) {
    recordStaffAuditEvent({
      actorStaffAccountId: staff?.id ?? null,
      canonicalAction: "admin.staff.login.password",
      result: "denied",
      now,
    });
    throw new StaffIdentityError("INVALID_CREDENTIALS");
  }
  if (staff.status === "suspended") throw new StaffIdentityError("STAFF_ACCOUNT_SUSPENDED");
  if (staff.status === "revoked") throw new StaffIdentityError("STAFF_ACCOUNT_REVOKED");
  if (staff.status !== "active") throw new StaffIdentityError("INVALID_CREDENTIALS");

  recordStaffAuditEvent({ actorStaffAccountId: staff.id, canonicalAction: "admin.staff.login.password", result: "success", now });

  const purpose = activeStaffPasskeyCount(staff.id) === 0 ? ("enrollment" as const) : ("login" as const);
  const pendingToken = await signPendingStaffToken({ staffAccountId: staff.id, purpose });
  return { staffAccountId: staff.id, purpose, pendingToken };
}

// Completes MFA login after a successful passkey assertion (called by the
// route handling API-AD-006 once verifyStaffPasskeyAssertion succeeds for
// purpose="login"). Business rule 20-21.
export async function completeStaffLogin(input: { staffAccountId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const db = getDb();
  const staff = db.prepare("select auth_user_id,authorization_generation from staff_accounts where id=?").get(
    input.staffAccountId,
  ) as { auth_user_id: string; authorization_generation: number } | undefined;
  if (!staff) throw new StaffIdentityError("RESOURCE_NOT_FOUND");

  const payload: StaffSessionPayload = {
    staffAccountId: input.staffAccountId,
    authUserId: staff.auth_user_id,
    sessionId: randomUUID(),
    authenticationTime: now.getTime(),
    mfaVerificationTime: now.getTime(),
    authorizationGeneration: staff.authorization_generation,
    roleKeys: activeRoleKeys(input.staffAccountId),
    lastActivityTime: now.getTime(),
  };
  recordStaffAuditEvent({
    actorStaffAccountId: input.staffAccountId,
    canonicalAction: "admin.staff.login.mfa",
    result: "success",
    now,
  });
  const token = await signStaffSession(payload);
  return { token, payload };
}

// Business rule 61: the reauth ceremony re-verifies the CURRENT password
// (first factor) before issuing the passkey-reauth challenge — the second
// factor. Requires an already-live full staff session (this is elevating
// an existing session, not logging in).
export async function beginStaffReauth(input: { staffAccountId: string; staffSessionId: string; currentPassword: string; now?: Date }) {
  const now = input.now ?? new Date();
  const db = getDb();
  const staff = db.prepare("select auth_user_id,status from staff_accounts where id=?").get(input.staffAccountId) as
    | { auth_user_id: string; status: string }
    | undefined;
  if (!staff || staff.status !== "active") throw new StaffIdentityError("FORBIDDEN");
  const authUser = db.prepare("select password_hash from users where id=?").get(staff.auth_user_id) as
    | { password_hash: string }
    | undefined;
  if (!authUser || !verifyPassword(input.currentPassword, authUser.password_hash)) {
    throw new StaffIdentityError("REAUTHENTICATION_REQUIRED");
  }
  const pendingToken = await signPendingStaffToken({
    staffAccountId: input.staffAccountId,
    purpose: "reauth",
    staffSessionId: input.staffSessionId,
  });
  return { pendingToken };
}
