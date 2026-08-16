// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";

beforeEach(() => {
  useInMemoryDb();
});

describe("AD-001 schema", () => {
  it("rejects a staff_accounts row for an auth_user_id that already has a parent profile", async () => {
    const { user } = await sqliteAuthAdapter.signUp("parent-conflict@example.com", "CorrectHorse1!");
    const db = getDb();
    expect(() =>
      db
        .prepare(`insert into staff_accounts (id,auth_user_id,normalized_email,status) values (?,?,?, 'invited')`)
        .run(randomUUID(), user.id, "parent-conflict-staff@example.com"),
    ).toThrow(/STAFF_AUTH_USER_ALREADY_PARENT/);
  });

  it("rejects a profiles row for an auth_user_id that already has a staff_accounts row", () => {
    const db = getDb();
    const userId = randomUUID();
    db.prepare(
      `insert into users (id,email,password_hash,email_verified_at) values (?,?,?,datetime('now'))`,
    ).run(userId, "staff-conflict@example.com", "hash");
    db.prepare(`insert into staff_accounts (id,auth_user_id,normalized_email,status) values (?,?,?, 'invited')`)
      .run(randomUUID(), userId, "staff-conflict@example.com");
    expect(() => db.prepare(`insert into profiles (id) values (?)`).run(userId)).toThrow(
      /PARENT_AUTH_USER_ALREADY_STAFF/,
    );
  });

  it("allows a staff_accounts row for a fresh auth_user_id with no profile", () => {
    const db = getDb();
    const userId = randomUUID();
    db.prepare(
      `insert into users (id,email,password_hash,email_verified_at) values (?,?,?,datetime('now'))`,
    ).run(userId, "fresh-staff@example.com", "hash");
    expect(() =>
      db
        .prepare(`insert into staff_accounts (id,auth_user_id,normalized_email,status) values (?,?,?, 'invited')`)
        .run(randomUUID(), userId, "fresh-staff@example.com"),
    ).not.toThrow();
    const row = db.prepare("select status from staff_accounts where auth_user_id=?").get(userId) as
      | { status: string }
      | undefined;
    expect(row?.status).toBe("invited");
  });

  it("rejects a duplicate normalized_email across two staff_accounts rows", () => {
    const db = getDb();
    const insertOne = (suffix: string) => {
      const userId = randomUUID();
      db.prepare(
        `insert into users (id,email,password_hash,email_verified_at) values (?,?,?,datetime('now'))`,
      ).run(userId, `dupe-${suffix}@example.com`, "hash");
      db.prepare(`insert into staff_accounts (id,auth_user_id,normalized_email,status) values (?,?,?, 'invited')`)
        .run(randomUUID(), userId, "dupe-target@example.com");
    };
    insertOne("a");
    expect(() => insertOne("b")).toThrow();
  });

  it("enforces at most one active role assignment per (staff, role) via the partial unique index", () => {
    const db = getDb();
    const userId = randomUUID();
    db.prepare(
      `insert into users (id,email,password_hash,email_verified_at) values (?,?,?,datetime('now'))`,
    ).run(userId, "role-dupe@example.com", "hash");
    const staffId = randomUUID();
    db.prepare(`insert into staff_accounts (id,auth_user_id,normalized_email,status) values (?,?,?, 'active')`)
      .run(staffId, userId, "role-dupe@example.com");
    db.prepare(
      `insert into staff_role_assignments (id,staff_account_id,role_key,assigned_at) values (?,?,?,datetime('now'))`,
    ).run(randomUUID(), staffId, "platform_administrator");
    expect(() =>
      db
        .prepare(
          `insert into staff_role_assignments (id,staff_account_id,role_key,assigned_at) values (?,?,?,datetime('now'))`,
        )
        .run(randomUUID(), staffId, "platform_administrator"),
    ).toThrow();
    // A removed assignment doesn't block a fresh active one for the same role.
    db.prepare("update staff_role_assignments set removed_at=datetime('now') where staff_account_id=? and role_key=?")
      .run(staffId, "platform_administrator");
    expect(() =>
      db
        .prepare(
          `insert into staff_role_assignments (id,staff_account_id,role_key,assigned_at) values (?,?,?,datetime('now'))`,
        )
        .run(randomUUID(), staffId, "platform_administrator"),
    ).not.toThrow();
  });
});
