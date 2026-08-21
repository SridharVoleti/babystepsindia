import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { resolveDbClient } from "@/lib/db-client";
import type { SecurityView } from "@/lib/db/account-security-repo";
import { maskEmail } from "@/lib/account/mask";

const EXPIRY_MS = 86_400_000;
const production = () => !!process.env.NEXT_PUBLIC_SUPABASE_URL;

export type CredentialResult = { ok: true } | { ok: false; code: string };

export async function changeAuthoritativePassword(input: {
  userId: string; email: string; currentPassword: string; newPassword: string;
}): Promise<CredentialResult> {
  if (!production()) {
    const { sqliteAuthAdapter } = await import("@/lib/auth/sqlite-auth-adapter");
    if (!(await sqliteAuthAdapter.signInWithPassword(input.email, input.currentPassword))) return { ok: false, code: "CURRENT_PASSWORD_INCORRECT" };
    if (await sqliteAuthAdapter.signInWithPassword(input.email, input.newPassword)) return { ok: false, code: "PASSWORD_UNCHANGED" };
    const { changePassword } = await import("@/lib/db/account-security-repo");
    changePassword(input.userId, input.newPassword);
    return { ok: true };
  }
  const auth = createClient().auth;
  const reauth = await auth.signInWithPassword({ email: input.email, password: input.currentPassword });
  if (reauth.error) return { ok: false, code: "CURRENT_PASSWORD_INCORRECT" };
  if (input.currentPassword === input.newPassword) return { ok: false, code: "PASSWORD_UNCHANGED" };
  const changed = await auth.updateUser({ password: input.newPassword });
  if (changed.error) throw changed.error;
  await recordEvent(input.userId, "password_changed");
  await enqueueAccountNotification(resolveDbClient(), input.userId, "account_password_changed", `password-changed:${input.userId}:${new Date().toISOString()}`);
  return { ok: true };
}

async function recordEvent(userId: string, eventType: string, metadata?: object) {
  await resolveDbClient().run(
    "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,?,?)",
    [randomUUID(), userId, eventType, metadata ? JSON.stringify(metadata) : null],
  );
}

async function enqueueAccountNotification(
  db: ReturnType<typeof resolveDbClient>, userId: string,
  notificationType: "account_password_changed" | "account_email_changed", sourceEventKey: string,
) {
  const templateVersion = "v1";
  const safeVariables = {};
  const semanticHash = createHash("sha256").update(JSON.stringify({
    notificationType, sourceDomain: "identity", sourceEventKey, parentId: userId,
    templateVersion, safeVariables,
  })).digest("hex");
  const now = new Date().toISOString();
  await db.run(`insert into transactional_notification_intents
    (notification_id,parent_id,notification_type,source_domain,source_event_key,source_version,template_version,safe_variables,semantic_hash,state,attempt_count,created_at,updated_at)
    values(?,?,?,'identity',?,1,?,'{}',?,'pending',0,?,?)
    on conflict(notification_type,source_domain,source_event_key,parent_id,template_version) do nothing`,
  [randomUUID(), userId, notificationType, sourceEventKey, templateVersion, semanticHash, now, now]);
}

export async function getAuthoritativeSecurityView(userId: string, email: string): Promise<SecurityView> {
  if (!production()) {
    const { getSecurityView } = await import("@/lib/db/account-security-repo");
    return getSecurityView(userId, email);
  }
  const pending = await resolveDbClient().get<{ new_email: string; expires_at: string }>(
    "select new_email,expires_at from email_change_requests where parent_user_id=? and status='pending'",
    [userId],
  );
  return { email, pendingEmailChange: pending ? { newEmail: pending.new_email, expiresAt: pending.expires_at } : null };
}

export async function requestAuthoritativeEmailChange(input: {
  userId: string; currentEmail: string; currentPassword: string; newEmail: string;
}) {
  if (!production()) {
    const { sqliteAuthAdapter } = await import("@/lib/auth/sqlite-auth-adapter");
    if (!(await sqliteAuthAdapter.signInWithPassword(input.currentEmail, input.currentPassword))) return { ok: false as const, code: "CURRENT_PASSWORD_INCORRECT" };
    const { requestEmailChange } = await import("@/lib/db/account-security-repo");
    const issued = requestEmailChange(input.userId, input.currentEmail, input.newEmail);
    return { ok: true as const, newEmail: input.newEmail, expiresAt: issued.expiresAt,
      localLink: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/email-change/callback?token=${issued.token}` };
  }
  const auth = createClient().auth;
  const reauth = await auth.signInWithPassword({ email: input.currentEmail, password: input.currentPassword });
  if (reauth.error) return { ok: false as const, code: "CURRENT_PASSWORD_INCORRECT" };
  const changed = await auth.updateUser({ email: input.newEmail }, {
    emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/account/security`,
  });
  if (changed.error) return { ok: false as const, code: "EMAIL_UNAVAILABLE" };
  const expiresAt = new Date(Date.now() + EXPIRY_MS).toISOString();
  const db = resolveDbClient();
  await db.transaction(async (tx) => {
    await tx.run("update email_change_requests set status='cancelled',cancelled_at=? where parent_user_id=? and status='pending'", [new Date().toISOString(), input.userId]);
    await tx.run(`insert into email_change_requests(id,parent_user_id,old_email,new_email,token_hash,status,expires_at)
      values(?,?,?,?,?,'pending',?)`, [randomUUID(), input.userId, input.currentEmail, input.newEmail, `supabase:${randomUUID()}`, expiresAt]);
  });
  await recordEvent(input.userId, "email_change_requested");
  return { ok: true as const, newEmail: input.newEmail, expiresAt };
}

export async function resendAuthoritativeEmailChange(userId: string) {
  if (!production()) {
    const { resendEmailChange } = await import("@/lib/db/account-security-repo");
    const issued = resendEmailChange(userId);
    return issued ? { expiresAt: issued.expiresAt, localLink: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/email-change/callback?token=${issued.token}` } : null;
  }
  const db = resolveDbClient();
  const pending = await db.get<{ id: string; new_email: string }>(
    "select id,new_email from email_change_requests where parent_user_id=? and status='pending'", [userId],
  );
  if (!pending) return null;
  const resent = await createClient().auth.resend({ type: "email_change", email: pending.new_email, options: {
    emailRedirectTo: `${process.env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/account/security`,
  } });
  if (resent.error) throw resent.error;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + EXPIRY_MS).toISOString();
  await db.run("update email_change_requests set expires_at=?,requested_at=? where id=?", [expiresAt, now, pending.id]);
  await recordEvent(userId, "email_change_resent");
  return { expiresAt };
}

export async function cancelAuthoritativeEmailChange(userId: string) {
  if (!production()) {
    const { cancelEmailChange } = await import("@/lib/db/account-security-repo");
    return cancelEmailChange(userId);
  }
  const db = resolveDbClient();
  const pending = await db.get<{ old_email: string }>(
    "select old_email from email_change_requests where parent_user_id=? and status='pending'", [userId],
  );
  if (!pending) return false;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!serviceKey || !url) throw new Error("Supabase admin credentials are required to cancel an email change");
  const admin = createSupabaseClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const reset = await admin.auth.admin.updateUserById(userId, { email: pending.old_email, email_confirm: true });
  if (reset.error) throw reset.error;
  const now = new Date().toISOString();
  const result = await db.run(
    "update email_change_requests set status='cancelled',cancelled_at=? where parent_user_id=? and status='pending'",
    [now, userId],
  );
  if (!result.changes) return false;
  await recordEvent(userId, "email_change_cancelled");
  return true;
}

export async function finalizeAuthoritativeEmailChange(userId: string, verifiedEmail: string) {
  if (!production()) return { archived: false };
  const db = resolveDbClient();
  return db.transaction(async (tx) => {
    const pending = await tx.get<{ id: string; old_email: string; new_email: string }>(
      "select id,old_email,new_email from email_change_requests where parent_user_id=? and new_email=? and status='pending'",
      [userId, verifiedEmail],
    );
    if (!pending) return { archived: false };
    const now = new Date().toISOString();
    await tx.run("insert into parent_email_history(id,parent_user_id,email,reason) values(?,?,?,'email_changed')", [randomUUID(), userId, pending.old_email]);
    await tx.run("update email_change_requests set status='verified',verified_at=? where id=?", [now, pending.id]);
    await tx.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'email_change_verified',?)", [randomUUID(), userId, JSON.stringify({ oldEmail: maskEmail(pending.old_email), newEmail: maskEmail(pending.new_email) })]);
    await enqueueAccountNotification(tx, userId, "account_email_changed", `email-changed:${pending.id}`);
    return { archived: true };
  });
}

export async function softDeleteAuthoritativeAccount(input: { userId: string; email: string; currentPassword: string }) {
  if (!production()) {
    const { sqliteAuthAdapter } = await import("@/lib/auth/sqlite-auth-adapter");
    if (!(await sqliteAuthAdapter.signInWithPassword(input.email, input.currentPassword))) return false;
    const { softDeleteAccount } = await import("@/lib/db/account-security-repo");
    softDeleteAccount(input.userId); return true;
  }
  const supabase = createClient();
  if ((await supabase.auth.signInWithPassword({ email: input.email, password: input.currentPassword })).error) return false;
  const now = new Date().toISOString();
  await resolveDbClient().transaction(async (tx) => {
    await tx.run(`update profiles set account_status='deleted',deleted_at=?,deleted_by_user_id=?,auth_revoked_before=?,updated_at=? where id=?`, [now, input.userId, now, now, input.userId]);
    await tx.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'account_soft_deleted',null)", [randomUUID(), input.userId]);
  });
  await supabase.auth.signOut({ scope: "global" });
  return true;
}
