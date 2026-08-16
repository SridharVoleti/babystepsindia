import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
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

function findAuthUserByStaffId(staffAccountId: string) {
  const staff = findStaffById(staffAccountId);
  if (!staff) return undefined;
  const authUser = getDb().prepare("select password_hash from users where id=?").get(staff.auth_user_id) as
    | { password_hash: string }
    | undefined;
  return authUser ? { staff, authUser } : undefined;
}

// Rule 45: a fresh session supersedes anything still outstanding for the
// same target — never more than one live recovery session per target.
function supersedeExistingSessions(targetStaffId: string, now: Date) {
  getDb()
    .prepare("update staff_recovery_sessions set consumed_at=? where target_staff_id=? and consumed_at is null")
    .run(now.toISOString(), targetStaffId);
}

function createSession(input: {
  targetStaffId: string; issuedByStaffId: string | null; method: "normal" | "break_glass"; now: Date;
}) {
  const db = getDb();
  const id = randomUUID();
  const timestamp = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + RECOVERY_SESSION_TTL_MS).toISOString();
  supersedeExistingSessions(input.targetStaffId, input.now);
  db.prepare(
    `insert into staff_recovery_sessions (id,target_staff_id,issued_by_staff_id,method,expires_at,created_at)
     values (?,?,?,?,?,?)`,
  ).run(id, input.targetStaffId, input.issuedByStaffId, input.method, expiresAt, timestamp);
  return { recoverySessionId: id, targetStaffId: input.targetStaffId, expiresAt };
}

// API-AD-027. Rules 38-41, 48-49: issued only by a DIFFERENT active
// Platform Administrator (route guard already confirmed the actor holds
// the role; the actor!==target and target-status checks live here).
export function issueNormalRecoverySession(
  actor: StaffCaller,
  input: { targetStaffId: string; reason: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const reason = validateSensitiveReason(input.reason);
  if (actor.staffAccountId === input.targetStaffId) throw new PlatformGovernanceError("SELF_RECOVERY_BLOCKED");
  const target = findStaffById(input.targetStaffId);
  if (!target) throw new PlatformGovernanceError("RESOURCE_NOT_FOUND");
  if (!["active", "suspended"].includes(target.status)) throw new PlatformGovernanceError("ACCOUNT_NOT_ELIGIBLE");

  const session = createSession({ targetStaffId: input.targetStaffId, issuedByStaffId: actor.staffAccountId, method: "normal", now });
  recordStaffAuditEvent({
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
  const staff = normalized ? findStaffByNormalizedEmail(normalized) : undefined;
  const resolved = staff ? findAuthUserByStaffId(staff.id) : undefined;
  if (!staff || !resolved || !verifyPassword(input.password, resolved.authUser.password_hash)) {
    throw new PlatformGovernanceError("INVALID_CREDENTIALS");
  }
  if (!["active", "suspended"].includes(staff.status)) throw new PlatformGovernanceError("INVALID_CREDENTIALS");
  const roleKeys = activeRoleKeys(staff.id);
  if (!roleKeys.includes("platform_administrator")) throw new PlatformGovernanceError("FORBIDDEN");
  if (countActivePlatformAdministrators(staff.id) > 0) throw new PlatformGovernanceError("OTHER_ADMINISTRATOR_AVAILABLE");

  const consumed = consumeRecoveryCode(input.recoveryCode.trim(), staff.id, now);
  if (!consumed) throw new PlatformGovernanceError("RECOVERY_CODE_INVALID");

  const session = createSession({ targetStaffId: staff.id, issuedByStaffId: null, method: "break_glass", now });
  // Rule 65: high-severity — canonical action name alone flags it distinctly
  // for the audit viewer, no separate severity column needed.
  recordStaffAuditEvent({
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
  const staff = normalized ? findStaffByNormalizedEmail(normalized) : undefined;
  const resolved = staff ? findAuthUserByStaffId(staff.id) : undefined;
  if (!staff || !resolved || !verifyPassword(input.password, resolved.authUser.password_hash)) {
    throw new PlatformGovernanceError("INVALID_CREDENTIALS");
  }
  const session = getDb()
    .prepare(
      `select id from staff_recovery_sessions where target_staff_id=? and consumed_at is null and expires_at>?
       order by created_at desc limit 1`,
    )
    .get(staff.id, now.toISOString()) as { id: string } | undefined;
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
export function completeRecoveryEnrollment(input: { recoverySessionId: string; staffAccountId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const db = getDb();
  const session = db
    .prepare(
      "select id from staff_recovery_sessions where id=? and target_staff_id=? and consumed_at is null and expires_at>?",
    )
    .get(input.recoverySessionId, input.staffAccountId, now.toISOString()) as { id: string } | undefined;
  if (!session) throw new PlatformGovernanceError("RECOVERY_SESSION_EXPIRED");
  db.transaction(() => {
    db.prepare("update staff_recovery_sessions set consumed_at=? where id=?").run(now.toISOString(), input.recoverySessionId);
    db.prepare("update staff_accounts set authorization_generation=authorization_generation+1,updated_at=? where id=?")
      .run(now.toISOString(), input.staffAccountId);
    recordStaffAuditEvent({
      actorStaffAccountId: input.staffAccountId, targetStaffAccountId: input.staffAccountId,
      canonicalAction: "admin.staff.recovery_session.complete", resourceType: "staff", resourceSafeId: input.staffAccountId,
      result: "success", now,
    });
  })();
}
