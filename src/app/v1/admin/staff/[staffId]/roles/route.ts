import { NextResponse } from "next/server";
import { requireAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";
import { staffFailure } from "@/lib/staff-identity/route-helpers";
import { STAFF_ROLE_KEYS, type StaffRoleKey } from "@/lib/staff-identity/contracts";
import { assignStaffRoles } from "@/lib/staff-identity/roles-service";

// API-AD-008: Platform Administrator + recent reauth + reason +
// expectedVersion/idempotency. Assigns the full approved role-key set to
// another staff account — no self-escalation, last-Platform-Administrator
// preserved (business rules 70-73).
export async function PUT(request: Request, { params }: { params: { staffId: string } }) {
  const guard = await requireAdminApi("admin.staff.roles.update");
  if (!guard.ok) return guard.response;
  const reauthFailure = requireStaffSensitiveReauth(guard.session);
  if (reauthFailure) return reauthFailure;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const roleKeys = Array.isArray(body.roleKeys) ? (body.roleKeys as unknown[]) : null;
  if (
    !roleKeys ||
    roleKeys.some((key) => typeof key !== "string" || !STAFF_ROLE_KEYS.includes(key as StaffRoleKey)) ||
    typeof body.reason !== "string" ||
    typeof body.expectedVersion !== "number" ||
    typeof body.idempotencyKey !== "string" || !body.idempotencyKey
  ) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = assignStaffRoles({
      actorStaffId: guard.session.staffAccountId,
      targetStaffId: params.staffId,
      roleKeys: roleKeys as StaffRoleKey[],
      reason: body.reason,
      expectedVersion: body.expectedVersion,
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return staffFailure(error);
  }
}
