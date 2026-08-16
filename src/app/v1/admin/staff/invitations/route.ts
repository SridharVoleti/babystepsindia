import { NextResponse } from "next/server";
import { requireAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";
import { staffFailure } from "@/lib/staff-identity/route-helpers";
import { createInvitation } from "@/lib/staff-identity/invitation-service";
import { STAFF_ROLE_KEYS, type StaffRoleKey } from "@/lib/staff-identity/contracts";

// API-AD-001: Platform Administrator + recent reauth; idempotent 24h
// invite for a normalized staff email and approved initial role keys.
export async function POST(request: Request) {
  const guard = await requireAdminApi("admin.staff.invitation.create");
  if (!guard.ok) return guard.response;
  const reauthFailure = requireStaffSensitiveReauth(guard.session);
  if (reauthFailure) return reauthFailure;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const roleKeys = Array.isArray(body.initialRoleKeys) ? (body.initialRoleKeys as unknown[]) : [];
  if (
    typeof body.email !== "string" ||
    typeof body.reason !== "string" ||
    roleKeys.length === 0 ||
    roleKeys.some((key) => typeof key !== "string" || !STAFF_ROLE_KEYS.includes(key as StaffRoleKey))
  ) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = createInvitation({
      byStaffId: guard.session.staffAccountId,
      email: body.email,
      initialRoleKeys: roleKeys as StaffRoleKey[],
      reason: body.reason,
    });
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return staffFailure(error);
  }
}
