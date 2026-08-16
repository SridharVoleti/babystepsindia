// AD-001: shared test fixture replacing the legacy is_admin=1 +
// admin_permissions seeding pattern. Creates a real staff_accounts row
// (+ role assignments) directly in the DB and returns a StaffSessionPayload
// a test can hand to a mocked getStaffSession() — every other part of the
// guard chain (findStaffById, isStaffSessionLive, activeRoleKeys,
// roleHasCapability) still runs for real against that row.
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { hashPassword } from "@/lib/auth/password";
import { findStaffByNormalizedEmail } from "@/lib/staff-identity/accounts-repo";
import { bootstrapFirstPlatformAdministrator } from "@/lib/staff-identity/bootstrap";
import type { StaffRoleKey } from "@/lib/staff-identity/contracts";
import type { StaffSessionPayload } from "@/lib/staff-identity/session";

// openDb() (src/lib/db/client.ts) now auto-runs bootstrapFirstPlatformAdministrator
// on every fresh DB, including the in-memory DB useInMemoryDb() resets to —
// so by the time a test explicitly calls it again, one already exists and
// it returns null. Tests that need the bootstrap admin's staffAccountId
// (not a fresh seedStaffSession fixture) should call this instead.
export function ensureBootstrapPlatformAdmin(now?: Date): string {
  const result = bootstrapFirstPlatformAdministrator(getDb(), now);
  if (result) return result.staffAccountId;
  const email = (process.env.ADMIN_EMAIL ?? "admin@babysteps.in").toLowerCase();
  return findStaffByNormalizedEmail(email)!.id;
}

export function seedStaffSession(
  roleKeys: StaffRoleKey[],
  options: { email?: string; now?: Date } = {},
): StaffSessionPayload {
  const db = getDb();
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  const authUserId = randomUUID();
  const staffId = randomUUID();
  const email = options.email ?? `staff-${staffId}@example.com`;

  db.prepare("insert into users (id,email,password_hash,email_verified_at) values (?,?,?,?)").run(
    authUserId,
    email,
    hashPassword(randomUUID()),
    timestamp,
  );
  db.prepare(
    `insert into staff_accounts (id,auth_user_id,normalized_email,status,activated_at,created_at,updated_at)
     values (?,?,?, 'active',?,?,?)`,
  ).run(staffId, authUserId, email, timestamp, timestamp, timestamp);
  for (const roleKey of roleKeys) {
    db.prepare(
      "insert into staff_role_assignments (id,staff_account_id,role_key,assigned_at) values (?,?,?,?)",
    ).run(randomUUID(), staffId, roleKey, timestamp);
  }

  return {
    staffAccountId: staffId,
    authUserId,
    sessionId: randomUUID(),
    authenticationTime: now.getTime(),
    mfaVerificationTime: now.getTime(),
    authorizationGeneration: 1,
    roleKeys,
    lastActivityTime: now.getTime(),
  };
}
