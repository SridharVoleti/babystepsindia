import { resolveDbClient } from "@/lib/db-client";
import type { DbParam } from "@/lib/db-client/types";
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

export async function findStaffById(staffAccountId: string): Promise<StaffAccountRow | undefined> {
  return resolveDbClient().get<StaffAccountRow>("select * from staff_accounts where id=?", [staffAccountId]);
}

export async function findStaffByAuthUserId(authUserId: string): Promise<StaffAccountRow | undefined> {
  return resolveDbClient().get<StaffAccountRow>("select * from staff_accounts where auth_user_id=?", [authUserId]);
}

export async function findStaffByNormalizedEmail(normalizedEmail: string): Promise<StaffAccountRow | undefined> {
  return resolveDbClient().get<StaffAccountRow>(
    "select * from staff_accounts where normalized_email=?", [normalizedEmail]);
}

export async function activeRoleKeys(staffAccountId: string): Promise<StaffRoleKey[]> {
  const rows = await resolveDbClient().all<{ role_key: StaffRoleKey }>(
    "select role_key from staff_role_assignments where staff_account_id=? and removed_at is null",
    [staffAccountId],
  );
  return rows.map((row) => row.role_key);
}

// Kept as the historical *Async-suffixed names too — some callers (auth
// preflight paths added before this file's full conversion) still import
// these explicitly; both names now resolve to the same implementation.
export const findStaffByIdAsync = findStaffById;
export const findStaffByNormalizedEmailAsync = findStaffByNormalizedEmail;
export const activeRoleKeysAsync = activeRoleKeys;

// Business rule 73: never let the last active Platform Administrator be
// suspended/revoked. "Active" here means status='active' AND currently
// holding the role (a suspended-but-still-role-assigned account doesn't
// count as protecting the seat).
export async function countActivePlatformAdministrators(excludingStaffId?: string): Promise<number> {
  const row = await resolveDbClient().get<{ n: number }>(
    `select count(*) as n from staff_accounts a
     join staff_role_assignments r on r.staff_account_id=a.id and r.removed_at is null
     where a.status='active' and r.role_key='platform_administrator'
     and (? is null or a.id<>?)`,
    [excludingStaffId ?? null, excludingStaffId ?? null],
  );
  return row!.n;
}

export async function listStaff(input: { cursor?: string; status?: StaffAccountStatus; limit?: number } = {}) {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const db = resolveDbClient();
  const conditions: string[] = [];
  const params: DbParam[] = [];
  if (input.status) {
    conditions.push("status=?");
    params.push(input.status);
  }
  if (input.cursor) {
    conditions.push("(created_at,id) < (select created_at,id from staff_accounts where id=?)");
    params.push(input.cursor);
  }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  const rows = await db.all<StaffAccountRow>(
    `select * from staff_accounts ${where} order by created_at desc, id desc limit ?`,
    [...params, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const staff: Array<StaffAccountRow & { roleKeys: StaffRoleKey[] }> = [];
  for (const row of page) {
    staff.push({ ...row, roleKeys: await activeRoleKeys(row.id) });
  }
  return {
    staff,
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}
