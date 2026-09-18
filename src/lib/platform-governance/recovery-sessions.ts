import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { verifyPassword } from "@/lib/auth/password";
import { normalizeEmail } from "@/lib/auth/validation";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import {
  activeRoleKeys, countActivePlatformAdministrators, findStaffByNormalizedEmail, findStaffById,
} from "@/lib/staff-identity/accounts-repo";
import { validateSensitiveReason } from "@/lib/staff-identity/reason-validation";
import { recordStaffAuditEvent } from "@/lib/staff-identity/staff-audit-log";
import { signPendingStaffToken } from "@/lib/staff-identity/session";
import { PlatformGovernanceError, RECOVERY_SESSION_TTL_MS } from "@/lib/platform-governance/contracts";
import { consumeRecoveryCode } from "@/lib/platform-governance/recovery-codes";

type StaffCaller = { staffAccountId: string; roleKeys: readonly string[] };

async function findAuthUserByStaffId(staffAccountId: string) {
  const staff = await findStaffById(staffAccountId);
  if (!staff) return undefined;
  const authUser = await resolveDbClient().get<{ password_hash: string }>(
    "select password_hash from users where id=?", [staff.auth_user_id]);
  return authUser ? { staff, authUser } : undefined;
}

// Rule 45: a fresh session supersedes anything still outstanding for the
// same target — never more than one live recovery session per target.
async function supersedeExistingSessions(db: DbClient, targetStaffId: string, now: Date) {
  await db.run(
    "update staff_recovery_sessions set consumed_at=? where target_staff_id=? and consumed_at is null",
    [now.toISOString(), targetStaffId],
  );
}

async function createSession(input: {
  targetStaffId: string; issuedByStaffId: string | null; method: "normal" | "break_glass"; now: Date;
}) {
  const db = resolveDbClient();
  const id = randomUUID();
  const timestamp = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + RECOVERY_SESSION_TTL_MS).toISOString();
  await supersedeExistingSessions(db, input.targetStaffId, input.now);
  await db.run(
    `insert into staff_recovery_sessions (id,target_staff_id,issued_by_staff_id,method,expires_at,created_at)
     values (?,?,?,?,?,?)`,
    [id, input.targetStaffId, input.issuedByStaffId, input.method, expiresAt, timestamp],
  );
  return { recoverySessionId: id, targetStaffId: input.targetStaffId, expiresAt };
}

// API-AD-027. Rules 38-41, 48-49: issued only by a DIFFERENT active
// Platform Administrator (route guard already confirmed the actor holds
// the role; the actor!==target and target-status checks live here).
export async function issueNormalRecoverySession(
  actor: StaffCaller,
  input: { targetStaffId: string; reason: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const reason = validateSensitiveReason(input.reason);
  if (actor.staffAccountId === input.targetStaffId) throw new PlatformGovernanceError("SELF_RECOVERY_BLOCKED");
  const target = await findStaffById(input.targetStaffId);
  if (!target) throw new PlatformGovernanceError("RESOURCE_NOT_FOUND");
  if (!["active", "suspended"].includes(target.status)) throw new PlatformGovernanceError("ACCOUNT_NOT_ELIGIBLE");

  const session = await createSession({ targetStaffId: input.targetStaffId, issuedByStaffId: actor.staffAccountId, method: "normal", now });
  await recordStaffAuditEvent({
    actorStaffAccountId: actor.staffAccountId, targetStaffAccountId: input.targetStaffId,
    canonicalAction: "admin.staff.recovery_session.create", resourceType: "staff", resourceSafeId: input.targetStaffId,
    reason, result: "success", now,
  });
  return session;
}

// API-AD-028. Rules 50, 57-65: pre-MFA, self-service by the target. Only
// usable when the target is an active/suspended Platform Administrator AND
// the server confirms no different active Platform Administrator exists
// (countActivePlatformAdministrators excludes the target already — the
// same helper roles-service/status-service use for last-admin protection).
// Consumes exactly one code atomically and, since password proof already
// happened in this same call, also returns a ready-to-use pendingToken —
// rule 42's "existing password" step is satisfied here, not a second time.
export async function issueBreakGlassRecoverySession(input: {
  email: string; password: string; recoveryCode: string; now?: Date;
}): Promise<{ recoverySessionId: string; expiresAt: string; pendingToken: string }> {
  const now = input.now ?? new Date();
  const normalized = normalizeEmail(input.email);
  if (!checkRateLimit(`platform-recovery-break-glass:${normalized ?? "unknown"}`, 5, 15 * 60_000)) {
    throw new PlatformGovernanceError("RATE_LIMITED");
  }
  const staff = normalized ? await findStaffByNormalizedEmail(normalized) : undefined;
  const resolved = staff ? await findAuthUserByStaffId(staff.id) : undefined;
  if (!staff || !resolved || !verifyPassword(input.password, resolved.authUser.password_hash)) {
    throw new PlatformGovernanceError("INVALID_CREDENTIALS");
  }
  if (!["active", "suspended"].includes(staff.status)) throw new PlatformGovernanceError("INVALID_CREDENTIALS");
  const roleKeys = await activeRoleKeys(staff.id);
  if (!roleKeys.includes("platform_administrator")) throw new PlatformGovernanceError("FORBIDDEN");
  if ((await countActivePlatformAdministrators(staff.id)) > 0) throw new PlatformGovernanceError("OTHER_ADMINISTRATOR_AVAILABLE");

  const consumed = await consumeRecoveryCode(input.recoveryCode.trim(), staff.id, now);
  if (!consumed) throw new PlatformGovernanceError("RECOVERY_CODE_INVALID");

  const session = await createSession({ targetStaffId: staff.id, issuedByStaffId: null, method: "break_glass", now });
  // Rule 65: high-severity — canonical action name alone flags it distinctly
  // for the audit viewer, no separate severity column needed.
  await recordStaffAuditEvent({
    actorStaffAccountId: staff.id, targetStaffAccountId: staff.id,
    canonicalAction: "admin.platform.recovery_code.used", resourceType: "staff", resourceSafeId: staff.id,
    reason: "Sole-Platform-Administrator break-glass recovery code consumed.", result: "success", now,
  });

  const pendingToken = await signPendingStaffToken({
    staffAccountId: staff.id, purpose: "staff_passkey_recovery", recoverySessionId: session.recoverySessionId,
  });
  return { ...session, pendingToken };
}

// Target-facing consumption step for a NORMAL (admin-issued) recovery
// session — rule 42: still requires the target's own existing password
// even though an admin already vouched for the request.
export async function consumeRecoverySessionWithPassword(input: {
  email: string; password: string; now?: Date;
}): Promise<{ pendingToken: string }> {
  const now = input.now ?? new Date();
  const normalized = normalizeEmail(input.email);
  if (!checkRateLimit(`platform-recovery-consume:${normalized ?? "unknown"}`, 10, 15 * 60_000)) {
    throw new PlatformGovernanceError("RATE_LIMITED");
  }
  const staff = normalized ? await findStaffByNormalizedEmail(normalized) : undefined;
  const resolved = staff ? await findAuthUserByStaffId(staff.id) : undefined;
  if (!staff || !resolved || !verifyPassword(input.password, resolved.authUser.password_hash)) {
    throw new PlatformGovernanceError("INVALID_CREDENTIALS");
  }
  const session = await resolveDbClient().get<{ id: string }>(
    `select id from staff_recovery_sessions where target_staff_id=? and consumed_at is null and expires_at>?
     order by created_at desc limit 1`,
    [staff.id, now.toISOString()],
  );
  if (!session) throw new PlatformGovernanceError("RECOVERY_SESSION_NOT_FOUND");

  const pendingToken = await signPendingStaffToken({
    staffAccountId: staff.id, purpose: "staff_passkey_recovery", recoverySessionId: session.id,
  });
  return { pendingToken };
}

// Called by the amended passkey /register route once the new credential is
// actually stored — rules 43-46: this is the one place a recovery session
// is marked consumed and the staff account's authorization_generation is
// bumped (the same fast-revocation counter AD-001 already uses for role/
// status changes), which also satisfies "recovery increments staff
// security/recovery generation" without a second counter column.
export async function completeRecoveryEnrollment(input: { recoverySessionId: string; staffAccountId: string; now?: Date }) {
  const now = input.now ?? new Date();
  await resolveDbClient().transaction(async (db: DbClient) => {
    const session = await db.get<{ id: string }>(
      "select id from staff_recovery_sessions where id=? and target_staff_id=? and consumed_at is null and expires_at>?",
      [input.recoverySessionId, input.staffAccountId, now.toISOString()],
    );
    if (!session) throw new PlatformGovernanceError("RECOVERY_SESSION_EXPIRED");
    await db.run("update staff_recovery_sessions set consumed_at=? where id=?", [now.toISOString(), input.recoverySessionId]);
    await db.run("update staff_accounts set authorization_generation=authorization_generation+1,updated_at=? where id=?",
      [now.toISOString(), input.staffAccountId]);
  });
  await recordStaffAuditEvent({
    actorStaffAccountId: input.staffAccountId, targetStaffAccountId: input.staffAccountId,
    canonicalAction: "admin.staff.recovery_session.complete", resourceType: "staff", resourceSafeId: input.staffAccountId,
    result: "success", now,
  });
}
