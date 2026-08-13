import { createHash, randomUUID } from "node:crypto";
import { maskEmail } from "@/lib/account/mask";
import { revokeLearnerContextsForParent } from "@/lib/authorization/modes";
import { revokeActiveLearnerSessionsForParent } from "@/lib/learning-session/gateway";
import { getDb } from "@/lib/db/client";
import { updateUserEmail, updateUserPassword } from "@/lib/db/users";
import type { EmailChangeRequest } from "@/lib/db/types";
import { enqueueTransactionalNotification } from "@/lib/notifications/service";

// Business rule 6: "Auth email-link expiry must be configured to 86,400
// seconds." Applied here as the local request's own expiry — the
// equivalent Supabase Auth project setting still needs configuring
// separately when this ports to a real Supabase project (see README).
const EMAIL_CHANGE_EXPIRY_MS = 86_400 * 1000;

// GAP-008: email-change verification tokens are one-way hashed before
// storage — the raw token only ever exists in memory long enough to be
// returned to the caller that just issued it and to be sent in the
// verification link.
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function recordEvent(parentUserId: string, eventType: string, metadata?: Record<string, unknown>) {
  getDb()
    .prepare(
      "insert into account_events (id, parent_user_id, event_type, metadata) values (?, ?, ?, ?)",
    )
    .run(randomUUID(), parentUserId, eventType, metadata ? JSON.stringify(metadata) : null);
}

export type SecurityView = {
  email: string;
  pendingEmailChange: { newEmail: string; expiresAt: string } | null;
};

export function getSecurityView(userId: string, email: string): SecurityView {
  const pending = getDb()
    .prepare(
      "select new_email, expires_at from email_change_requests where parent_user_id = ? and status = 'pending'",
    )
    .get(userId) as { new_email: string; expires_at: string } | undefined;

  return {
    email,
    pendingEmailChange: pending
      ? { newEmail: pending.new_email, expiresAt: pending.expires_at }
      : null,
  };
}

// AC3/AT-IA-003-01: password itself is never logged — only the fact that
// it changed goes into account_events.
export function changePassword(userId: string, newPassword: string): void {
  const now = new Date();
  const run = getDb().transaction(() => {
    updateUserPassword(userId, newPassword);
    revokeLearnerContextsForParent(userId, now);
    recordEvent(userId, "password_changed");
    // NT-001 rule 37: IA-003 owns the account-change trigger; NT-001 only
    // delivers it.
    enqueueTransactionalNotification({
      notificationType: "account_password_changed", sourceDomain: "identity",
      sourceEventKey: `password-changed:${userId}:${now.toISOString()}`, sourceVersion: 1,
      parentId: userId, safeVariables: {},
    }, now);
  });
  run();
}

export type EmailChangeIssued = { id: string; token: string; expiresAt: string };

// Alt flow "Pending request replaced": cancels any existing pending
// request before creating the new one, rather than being blocked by the
// partial unique index (business rule 10).
export function requestEmailChange(
  userId: string,
  oldEmail: string,
  newEmail: string,
): EmailChangeIssued {
  const db = getDb();
  const id = randomUUID();
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_EXPIRY_MS).toISOString();

  const run = db.transaction(() => {
    db.prepare(
      `update email_change_requests
       set status = 'cancelled', cancelled_at = datetime('now')
       where parent_user_id = ? and status = 'pending'`,
    ).run(userId);

    db.prepare(
      `insert into email_change_requests (id, parent_user_id, old_email, new_email, token_hash, status, expires_at)
       values (?, ?, ?, ?, ?, 'pending', ?)`,
    ).run(id, userId, oldEmail, newEmail, hashToken(token), expiresAt);

    recordEvent(userId, "email_change_requested", { newEmail: maskEmail(newEmail) });
  });
  run();

  return { id, token, expiresAt };
}

// AT-IA-003-06 negative case: resend always issues a fresh token and a
// fresh 24h expiry on the same pending row (not a second request row).
export function resendEmailChange(userId: string): EmailChangeIssued | null {
  const db = getDb();
  const existing = db
    .prepare("select id from email_change_requests where parent_user_id = ? and status = 'pending'")
    .get(userId) as { id: string } | undefined;
  if (!existing) return null;

  const token = randomUUID();
  const expiresAt = new Date(Date.now() + EMAIL_CHANGE_EXPIRY_MS).toISOString();

  db.prepare(
    `update email_change_requests
     set token_hash = ?, expires_at = ?, requested_at = datetime('now')
     where id = ?`,
  ).run(hashToken(token), expiresAt, existing.id);

  recordEvent(userId, "email_change_resent");

  return { id: existing.id, token, expiresAt };
}

export function cancelEmailChange(userId: string): boolean {
  const result = getDb()
    .prepare(
      `update email_change_requests
       set status = 'cancelled', cancelled_at = datetime('now')
       where parent_user_id = ? and status = 'pending'`,
    )
    .run(userId);

  if (result.changes === 0) return false;

  recordEvent(userId, "email_change_cancelled");
  return true;
}

export type ApplyEmailChangeResult =
  | { ok: true; parentUserId: string; newEmail: string }
  | { ok: false; code: "INVALID_TOKEN" | "EXPIRED" };

// Step 1 of 2 (the "Auth side changed" step). Deliberately doesn't archive
// the old email or mark the request verified here — see
// finalizeEmailChange, which does that idempotently and is also the
// reconciliation entry point (AT-IA-003-08).
export function applyEmailChangeToken(token: string): ApplyEmailChangeResult {
  const db = getDb();
  const request = db
    .prepare("select * from email_change_requests where token_hash = ?")
    .get(hashToken(token)) as EmailChangeRequest | undefined;

  if (!request || request.status === "cancelled" || request.status === "expired") {
    return { ok: false, code: "INVALID_TOKEN" };
  }

  if (request.status === "verified") {
    // Replayed callback: already-completed result, no re-application
    // (Alt flow "Verification callback replayed").
    return { ok: true, parentUserId: request.parent_user_id, newEmail: request.new_email };
  }

  if (new Date(request.expires_at) < new Date()) {
    db.prepare("update email_change_requests set status = 'expired' where id = ?").run(request.id);
    return { ok: false, code: "EXPIRED" };
  }

  updateUserEmail(request.parent_user_id, request.new_email);
  return { ok: true, parentUserId: request.parent_user_id, newEmail: request.new_email };
}

// Step 2 of 2, and the reconciliation function: idempotent by
// construction — it only acts when a 'pending' request's new_email
// matches the user's current email, and flips that request out of
// 'pending' as part of the same transaction, so a second call finds
// nothing left to do.
export function finalizeEmailChange(parentUserId: string): { archived: boolean } {
  const db = getDb();
  const user = db.prepare("select email from users where id = ?").get(parentUserId) as
    | { email: string }
    | undefined;
  if (!user) return { archived: false };

  const request = db
    .prepare(
      `select * from email_change_requests
       where parent_user_id = ? and new_email = ? and status = 'pending'`,
    )
    .get(parentUserId, user.email) as EmailChangeRequest | undefined;

  if (!request) {
    return { archived: false };
  }

  const now = new Date();
  const run = db.transaction(() => {
    db.prepare(
      "insert into parent_email_history (id, parent_user_id, email, reason) values (?, ?, ?, 'email_changed')",
    ).run(randomUUID(), parentUserId, request.old_email);

    db.prepare(
      "update email_change_requests set status = 'verified', verified_at = datetime('now') where id = ?",
    ).run(request.id);

    // GAP-011: account_events is a routine/support-visible audit trail, not
    // the authoritative archive (that's parent_email_history, which
    // deliberately keeps the full old_email per its own append-only
    // business rule) — mask both addresses here.
    recordEvent(parentUserId, "email_change_verified", {
      oldEmail: maskEmail(request.old_email),
      newEmail: maskEmail(request.new_email),
    });
    // NT-001 rule 16/37: IA-003 owns the account-change trigger; NT-001
    // resolves the current verified email at send time regardless (so this
    // enqueue call doesn't need to carry the new address itself).
    enqueueTransactionalNotification({
      notificationType: "account_email_changed", sourceDomain: "identity",
      sourceEventKey: `email-changed:${request.id}`, sourceVersion: 1,
      parentId: parentUserId, safeVariables: {},
    }, now);
  });
  run();

  return { archived: true };
}

// Soft delete only — never touches auth.users, learner, progress,
// consent, billing, invoice, or audit rows (business rule 11).
export function softDeleteAccount(userId: string): void {
  const run = getDb().transaction(() => {
    getDb()
      .prepare(
        `update profiles set
           account_status = 'deleted',
           deleted_at = datetime('now'),
           deleted_by_user_id = ?,
           auth_revoked_before = datetime('now'),
           updated_at = datetime('now')
         where id = ?`,
      )
      .run(userId, userId);

    revokeLearnerContextsForParent(userId,new Date());
    revokeActiveLearnerSessionsForParent(userId, "account_soft_deleted", new Date());

    recordEvent(userId, "account_soft_deleted");
  });
  run();
}

// Admin-only (authorization enforced by the caller). Deliberately leaves
// auth_revoked_before untouched — that's what forces a fresh login
// instead of resurrecting a pre-deletion session (business rule 14).
export function restoreAccount(parentUserId: string, adminUserId: string, reason: string): void {
  const run = getDb().transaction(() => {
    getDb()
      .prepare(
        `update profiles set
           account_status = 'active',
           deleted_at = null,
           deleted_by_user_id = null,
           updated_at = datetime('now')
         where id = ?`,
      )
      .run(parentUserId);

    recordEvent(parentUserId, "account_restored", { reason, restoredBy: adminUserId });
  });
  run();
}
