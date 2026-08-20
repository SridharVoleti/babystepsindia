import { getDb } from "@/lib/db/client";
import { resolveDbClient } from "@/lib/db-client";
import type { StaffAccountStatus, StaffRoleKey } from "@/lib/staff-identity/contracts";

export type StaffAccountRow = {
  id: string;
  auth_user_id: string;
  normalized_email: string;
  display_name: string | null;
  status: StaffAccountStatus;
  authorization_generation: number;
  invited_by_staff_id: string | null;
  invitation_expires_at: string | null;
  activated_at: string | null;
  suspended_at: string | null;
  revoked_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export function findStaffById(staffAccountId: string): StaffAccountRow | undefined {
  return getDb().prepare("select * from staff_accounts where id=?").get(staffAccountId) as
    | StaffAccountRow
    | undefined;
}

export function findStaffByAuthUserId(authUserId: string): StaffAccountRow | undefined {
  return getDb().prepare("select * from staff_accounts where auth_user_id=?").get(authUserId) as
    | StaffAccountRow
    | undefined;
}

export function findStaffByNormalizedEmail(normalizedEmail: string): StaffAccountRow | undefined {
  return getDb().prepare("select * from staff_accounts where normalized_email=?").get(normalizedEmail) as
    | StaffAccountRow
    | undefined;
}

export function activeRoleKeys(staffAccountId: string): StaffRoleKey[] {
  const rows = getDb()
    .prepare("select role_key from staff_role_assignments where staff_account_id=? and removed_at is null")
    .all(staffAccountId) as Array<{ role_key: StaffRoleKey }>;
  return rows.map((row) => row.role_key);
}

// Async twins of findStaffById/activeRoleKeys above, for requireAdmin
// (src/lib/auth/guards.ts) — an ordinary async preflight check, not
// nested in any transaction, so safe to resolve via resolveDbClient().
// Deliberately additive: the sync originals stay untouched for their
// existing callers nested inside operations-admin/roles-service/status-
// service's synchronous transactions (deferred, larger work — see
// project history on withLockedEndUserMutation/the "gray zone").
export async function findStaffByIdAsync(staffAccountId: string): Promise<StaffAccountRow | undefined> {
  return resolveDbClient().get<StaffAccountRow>("select * from staff_accounts where id=?", [staffAccountId]);
}

export async function activeRoleKeysAsync(staffAccountId: string): Promise<StaffRoleKey[]> {
  const rows = await resolveDbClient().all<{ role_key: StaffRoleKey }>(
    "select role_key from staff_role_assignments where staff_account_id=? and removed_at is null",
    [staffAccountId],
  );
  return rows.map((row) => row.role_key);
}

// Business rule 73: never let the last active Platform Administrator be
// suspended/revoked. "Active" here means status='active' AND currently
// holding the role (a suspended-but-still-role-assigned account doesn't
// count as protecting the seat).
export function countActivePlatformAdministrators(excludingStaffId?: string): number {
  const row = getDb()
    .prepare(
      `select count(*) as n from staff_accounts a
       join staff_role_assignments r on r.staff_account_id=a.id and r.removed_at is null
       where a.status='active' and r.role_key='platform_administrator'
       and (? is null or a.id<>?)`,
    )
    .get(excludingStaffId ?? null, excludingStaffId ?? null) as { n: number };
  return row.n;
}

export function listStaff(input: { cursor?: string; status?: StaffAccountStatus; limit?: number } = {}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.status) {
    conditions.push("status=?");
    params.push(input.status);
  }
  if (input.cursor) {
    conditions.push("(created_at,id) < (select created_at,id from staff_accounts where id=?)");
    params.push(input.cursor);
  }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const rows = db
    .prepare(`select * from staff_accounts ${where} order by created_at desc, id desc limit ?`)
    .all(...params, limit + 1) as StaffAccountRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    staff: page.map((row) => ({ ...row, roleKeys: activeRoleKeys(row.id) })),
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}
