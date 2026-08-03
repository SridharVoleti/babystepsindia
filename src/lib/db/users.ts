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

export function consumePasswordResetToken(token: string): string | null {
  const db = getDb();
  const row = db
    .prepare(
      "select user_id, expires_at from password_reset_tokens where token = ?",
    )
    .get(token) as { user_id: string; expires_at: string } | undefined;

  if (!row) return null;

  db.prepare("delete from password_reset_tokens where token = ?").run(token);

  if (new Date(row.expires_at) < new Date()) return null;

  return row.user_id;
}
