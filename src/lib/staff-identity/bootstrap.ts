import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { hashPassword } from "@/lib/auth/password";
import { STAFF_ROLE_KEYS } from "@/lib/staff-identity/contracts";
import { bootstrapRecoveryCodes, bootstrapRecoveryCodesAsync } from "@/lib/platform-governance/recovery-codes";
import { resolveDbClient } from "@/lib/db-client";

// Replaces the legacy seedAdminIfMissing (src/lib/db/client.ts) — creates
// the very first staff identity through a secured, env-driven, one-time
// procedure (business rule 74) rather than public signup. Business rule
// 139: bootstrap may explicitly seed all four V1 roles for the initial
// owner/operator (this is what makes them display as Super Admin).
//
// No usable admin session is issued here — status is 'active' and a
// password is set, but zero passkeys exist yet, so the first real login
// must go through passkey enrollment (business rule 26) before any admin
// API call succeeds.
export function bootstrapFirstPlatformAdministrator(db: Database.Database, now = new Date()) {
  const existing = db
    .prepare(
      `select count(*) as n from staff_accounts a
       join staff_role_assignments r on r.staff_account_id=a.id and r.removed_at is null
       where r.role_key='platform_administrator'`,
    )
    .get() as { n: number };
  if (existing.n > 0) return null;

  const email = (process.env.ADMIN_EMAIL ?? "admin@babysteps.in").toLowerCase();
  // Defensive: don't attempt the insert if this exact bootstrap identity
  // was already provisioned (e.g. by an earlier role-mutation test in a
  // shared/reused DB connection that later removed its platform_
  // administrator assignment) — a taken email with no qualifying role is
  // still not this function's job to repair.
  if (db.prepare("select 1 from users where email=?").get(email)) return null;
  const password = process.env.ADMIN_PASSWORD ?? "changeme123";
  const authUserId = randomUUID();
  const staffId = randomUUID();
  const timestamp = now.toISOString();

  db.transaction(() => {
    db.prepare("insert into users (id,email,password_hash,email_verified_at) values (?,?,?,?)").run(
      authUserId,
      email,
      hashPassword(password),
      timestamp,
    );
    db.prepare(
      `insert into staff_accounts (id,auth_user_id,normalized_email,display_name,status,activated_at,created_at,updated_at)
       values (?,?,?,?, 'active',?,?,?)`,
    ).run(staffId, authUserId, email, "Bootstrap Administrator", timestamp, timestamp, timestamp);
    for (const roleKey of STAFF_ROLE_KEYS) {
      db.prepare(
        "insert into staff_role_assignments (id,staff_account_id,role_key,assigned_at) values (?,?,?,?)",
      ).run(randomUUID(), staffId, roleKey, timestamp);
    }
  })();

  // eslint-disable-next-line no-console
  console.log(
    `[babysteps] Seeded bootstrap Platform Administrator: ${email} / ${password} (set ADMIN_EMAIL / ADMIN_PASSWORD to override). Log in and enroll a passkey to activate admin access.`,
  );

  // AD-005 rule 51: at least two sole-Platform-Administrator break-glass
  // recovery codes exist from first boot, not only after a later rotation.
  // Passes this same already-open db handle through — see the singleton
  // re-entrancy note on generateCodeBatch in recovery-codes.ts.
  bootstrapRecoveryCodes(db, now);

  return { staffAccountId: staffId, authUserId };
}

// Async, resolveDbClient()-based counterpart of the sync function above,
// for a real Postgres/Supabase environment — the sync version above is
// wired only into getDb()'s SQLite singleton init (src/lib/db/client.ts)
// and takes a raw better-sqlite3 handle, so it never runs against
// production. Not wired into any request path (this app's real signup is
// custom email/password against public.users, so there is no "first
// request creates the first admin" moment to hook) — meant to be invoked
// once, deliberately, e.g. from a one-off script, same as this codebase's
// other production-bootstrap/verification scripts.
export async function bootstrapFirstPlatformAdministratorAsync(password: string, now = new Date()) {
  const email = (process.env.ADMIN_EMAIL ?? "admin@babysteps.in").toLowerCase();
  return resolveDbClient().transaction(async (tx) => {
    const existing = await tx.get<{ n: number }>(
      `select count(*) as n from staff_accounts a
       join staff_role_assignments r on r.staff_account_id=a.id and r.removed_at is null
       where r.role_key='platform_administrator'`,
    );
    if ((existing?.n ?? 0) > 0) return null;

    if (await tx.get("select 1 from users where email=?", [email])) return null;

    const authUserId = randomUUID();
    const staffId = randomUUID();
    const timestamp = now.toISOString();

    await tx.run(
      "insert into users (id,email,password_hash,email_verified_at) values (?,?,?,?)",
      [authUserId, email, hashPassword(password), timestamp],
    );
    await tx.run(
      `insert into staff_accounts (id,auth_user_id,normalized_email,display_name,status,activated_at,created_at,updated_at)
       values (?,?,?,?, 'active',?,?,?)`,
      [staffId, authUserId, email, "Bootstrap Administrator", timestamp, timestamp, timestamp],
    );
    for (const roleKey of STAFF_ROLE_KEYS) {
      await tx.run(
        "insert into staff_role_assignments (id,staff_account_id,role_key,assigned_at) values (?,?,?,?)",
        [randomUUID(), staffId, roleKey, timestamp],
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `[babysteps] Seeded bootstrap Platform Administrator: ${email}. Log in and enroll a passkey to activate admin access.`,
    );

    await bootstrapRecoveryCodesAsync(tx, now);

    return { staffAccountId: staffId, authUserId };
  });
}
