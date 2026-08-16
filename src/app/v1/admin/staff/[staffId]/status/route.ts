import { NextResponse } from "next/server";
import { requireAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";
import { staffFailure } from "@/lib/staff-identity/route-helpers";
import { changeStaffStatus } from "@/lib/staff-identity/status-service";

const VALID_STATUSES = ["active", "suspended", "revoked"] as const;

// API-AD-007: Platform Administrator + recent reauth + reason +
// expectedVersion/idempotency. Suspend/revoke another staff account —
// self and last-Platform-Administrator both blocked in the service layer.
export async function PATCH(request: Request, { params }: { params: { staffId: string } }) {
  const guard = await requireAdminApi("admin.staff.status.update");
  if (!guard.ok) return guard.response;
  const reauthFailure = requireStaffSensitiveReauth(guard.session);
  if (reauthFailure) return reauthFailure;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (
    typeof body.status !== "string" || !VALID_STATUSES.includes(body.status as (typeof VALID_STATUSES)[number]) ||
    typeof body.reason !== "string" ||
    typeof body.expectedVersion !== "number" ||
    typeof body.idempotencyKey !== "string" || !body.idempotencyKey
  ) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = changeStaffStatus({
      actorStaffId: guard.session.staffAccountId,
      targetStaffId: params.staffId,
      newStatus: body.status as "active" | "suspended" | "revoked",
      reason: body.reason,
      expectedVersion: body.expectedVersion,
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return staffFailure(error);
  }
}
