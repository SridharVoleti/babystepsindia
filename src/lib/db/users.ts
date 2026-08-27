import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import type { User } from "@/lib/db/types";

export async function findUserByEmail(email: string): Promise<User | undefined> {
  return resolveDbClient().get<User>(
    "select * from users where email = ?", [email.toLowerCase()]);
}

export async function findUserById(id: string): Promise<User | undefined> {
  return resolveDbClient().get<User>("select * from users where id = ?", [id]);
}

export async function createUser(
  email: string,
  password: string,
  displayName: string | null,
): Promise<User> {
  const id = randomUUID();
  const passwordHash = hashPassword(password);

  await resolveDbClient().transaction(async (db: DbClient) => {
    await db.run(
      "insert into users (id, email, password_hash) values (?, ?, ?)",
      [id, email.toLowerCase(), passwordHash],
    );
    await db.run("insert into profiles (id, display_name) values (?, ?)", [id, displayName]);
  });

  return (await findUserById(id))!;
}

export async function authenticate(email: string, password: string): Promise<User | null> {
  const user = await findUserByEmail(email);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  // A staff identity (src/app/staff/login) and a parent identity are
  // mutually exclusive on the same auth_user_id (business rules 4-5,
  // 121-123; enforced at the DB level by profiles_no_staff_conflict()).
  // Without this check, a staff account's credentials would pass this
  // parent-facing check too (staff and parents share the same `users`
  // password table) and load loadParentContext()'s ensureParentProfile()
  // straight into that DB trigger's uncaught rejection. Same generic
  // null as a wrong password — never reveal that the address is staff.
  const staff = await resolveDbClient().get("select 1 from staff_accounts where auth_user_id = ?", [user.id]);
  if (staff) return null;
  return user;
}

export async function updateUserPassword(userId: string, password: string) {
  await resolveDbClient().run(
    "update users set password_hash = ? where id = ?", [hashPassword(password), userId]);
}

// IA-003: the "Auth email changed" side of an email-change verification.
// Deliberately not unique-checked here — the caller (account-security-repo)
// already validated availability before creating the pending request.
export async function updateUserEmail(userId: string, newEmail: string) {
  await resolveDbClient().run(
    "update users set email = ? where id = ?", [newEmail.toLowerCase(), userId]);
}

// One unconsumed token per user: replaces any existing one, so a resend
// invalidates the token from the original signup email.
export async function createEmailVerificationToken(userId: string): Promise<string> {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await resolveDbClient().transaction(async (db: DbClient) => {
    await db.run("delete from email_verification_tokens where user_id = ?", [userId]);
    await db.run(
      "insert into email_verification_tokens (token, user_id, expires_at) values (?, ?, ?)",
      [token, userId, expiresAt],
    );
  });

  return token;
}

export async function verifyEmailWithToken(token: string): Promise<User | null> {
  return resolveDbClient().transaction(async (db: DbClient) => {
    const row = await db.get<{ user_id: string; expires_at: string }>(
      "select user_id, expires_at from email_verification_tokens where token = ?", [token]);

    if (!row) return null;
    if (new Date(row.expires_at) < new Date()) {
      await db.run("delete from email_verification_tokens where token = ?", [token]);
      return null;
    }

    await db.run(
      "update users set email_verified_at = ? where id = ?",
      [new Date().toISOString(), row.user_id],
    );
    await db.run("delete from email_verification_tokens where user_id = ?", [row.user_id]);
    return (await db.get<User>("select * from users where id = ?", [row.user_id])) ?? null;
  });
}

export async function createPasswordResetToken(userId: string): Promise<string> {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await resolveDbClient().run(
    "insert into password_reset_tokens (token, user_id, expires_at) values (?, ?, ?)",
    [token, userId, expiresAt],
  );
  return token;
}

export async function resetPasswordWithToken(token: string, password: string): Promise<User | null> {
  return resolveDbClient().transaction(async (db: DbClient) => {
    const row = await db.get<{ user_id: string; expires_at: string }>(
      "select user_id, expires_at from password_reset_tokens where token = ?", [token]);

    if (!row) return null;
    if (new Date(row.expires_at) < new Date()) {
      await db.run("delete from password_reset_tokens where token = ?", [token]);
      return null;
    }

    // A successful reset consumes every outstanding link for the account,
    // including links issued before the one the parent chose to use.
    await db.run("delete from password_reset_tokens where user_id = ?", [row.user_id]);
    await db.run(
      "update users set password_hash = ? where id = ?",
      [hashPassword(password), row.user_id],
    );
    return (await db.get<User>("select * from users where id = ?", [row.user_id])) ?? null;
  });
}
