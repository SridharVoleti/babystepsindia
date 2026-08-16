import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/staff-identity/guard";
import { listStaff } from "@/lib/staff-identity/accounts-repo";
import type { StaffAccountStatus } from "@/lib/staff-identity/contracts";

const VALID_STATUSES = ["invited", "active", "suspended", "revoked"] as const;

// API-AD-009: Platform Administrator/staff-governance read capability.
// Paginated safe staff identity/status/role list.
export async function GET(request: Request) {
  const guard = await requireAdminApi("admin.staff.list.read");
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const status =
    statusParam && VALID_STATUSES.includes(statusParam as (typeof VALID_STATUSES)[number])
      ? (statusParam as StaffAccountStatus)
      : undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;

  const { staff, nextCursor } = listStaff({ cursor, status, limit });
  return NextResponse.json(
    {
      staff: staff.map((row) => ({
        staffAccountId: row.id,
        normalizedEmail: row.normalized_email,
        displayName: row.display_name,
        status: row.status,
        roleKeys: row.roleKeys,
        version: row.version,
        createdAt: row.created_at,
      })),
      nextCursor,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
