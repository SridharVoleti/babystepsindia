import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import type { User } from "@/lib/db/types";

export function findUserByEmail(email: string): User | undefined {
  return getDb()
    .prepare("select * from users where email = ?")
    .get(email.toLowerCase()) as User | undefined;
}

export function findUserById(id: string): User | undefined {
  return getDb().prepare("select * from users where id = ?").get(id) as
    | User
    | undefined;
}

export function createUser(
  email: string,
  password: string,
  displayName: string | null,
): User {
  const db = getDb();
  const id = randomUUID();

  const insert = db.transaction(() => {
    db.prepare(
      "insert into users (id, email, password_hash) values (?, ?, ?)",
    ).run(id, email.toLowerCase(), hashPassword(password));
    db.prepare("insert into profiles (id, display_name) values (?, ?)").run(
      id,
      displayName,
    );
  });
  insert();

  return findUserById(id)!;
}

export function authenticate(email: string, password: string): User | null {
  const user = findUserByEmail(email);
  if (!user) return null;
  return verifyPassword(password, user.password_hash) ? user : null;
}

export function updateUserPassword(userId: string, password: string) {
  getDb()
    .prepare("update users set password_hash = ? where id = ?")
    .run(hashPassword(password), userId);
}

// IA-003: the "Auth email changed" side of an email-change verification.
// Deliberately not unique-checked here — the caller (account-security-repo)
// already validated availability before creating the pending request.
export function updateUserEmail(userId: string, newEmail: string) {
  getDb()
    .prepare("update users set email = ? where id = ?")
    .run(newEmail.toLowerCase(), userId);
}

// One unconsumed token per user: replaces any existing one, so a resend
// invalidates the token from the original signup email.
export function createEmailVerificationToken(userId: string): string {
  const db = getDb();
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const issue = db.transaction(() => {
    db.prepare("delete from email_verification_tokens where user_id = ?").run(userId);
    db.prepare(
      "insert into email_verification_tokens (token, user_id, expires_at) values (?, ?, ?)",
    ).run(token, userId, expiresAt);
  });
  issue();

  return token;
}

export function verifyEmailWithToken(token: string): User | null {
  const db = getDb();
  const verify = db.transaction(() => {
    const row = db
      .prepare(
        "select user_id, expires_at from email_verification_tokens where token = ?",
      )
      .get(token) as { user_id: string; expires_at: string } | undefined;

    if (!row) return null;
    if (new Date(row.expires_at) < new Date()) {
      db.prepare("delete from email_verification_tokens where token = ?").run(token);
      return null;
    }

    db.prepare("update users set email_verified_at = datetime('now') where id = ?")
      .run(row.user_id);
    db.prepare("delete from email_verification_tokens where user_id = ?").run(row.user_id);
    return findUserById(row.user_id) ?? null;
  });
  return verify.immediate();
}

export function createPasswordResetToken(userId: string): string {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  getDb()
    .prepare(
      "insert into password_reset_tokens (token, user_id, expires_at) values (?, ?, ?)",
    )
    .run(token, userId, expiresAt);
  return token;
}

export function resetPasswordWithToken(token: string, password: string): User | null {
  const db = getDb();
  const reset = db.transaction(() => {
    const row = db
      .prepare(
        "select user_id, expires_at from password_reset_tokens where token = ?",
      )
      .get(token) as { user_id: string; expires_at: string } | undefined;

    if (!row) return null;
    if (new Date(row.expires_at) < new Date()) {
      db.prepare("delete from password_reset_tokens where token = ?").run(token);
      return null;
    }

    // A successful reset consumes every outstanding link for the account,
    // including links issued before the one the parent chose to use.
    db.prepare("delete from password_reset_tokens where user_id = ?").run(row.user_id);
    db.prepare("update users set password_hash = ? where id = ?")
      .run(hashPassword(password), row.user_id);
    return findUserById(row.user_id) ?? null;
  });
  return reset.immediate();
}
