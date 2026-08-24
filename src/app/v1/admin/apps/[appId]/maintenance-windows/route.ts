import { NextResponse } from "next/server";
import { requireAdminApi, requireReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AppAvailabilityError, appAvailabilityErrorStatus, scheduleMaintenanceWindow } from
  "@/lib/app-availability/service";
import { requireOperationChangeForMutation, recordOperationOutcome } from "@/lib/operations-admin/service";
import { OperationChangeError, operationChangeErrorStatus } from "@/lib/operations-admin/contracts";

export async function POST(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.app_availability.manage");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`maintenance-window:${guard.session.sub}`, 30, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 }); }
  const reauthFailure = await requireReauth(guard.session);
  if (reauthFailure) return reauthFailure;
  const startsAt = typeof body.startsAt === "string" ? new Date(body.startsAt) : new Date(NaN);
  const endsAt = typeof body.endsAt === "string" ? new Date(body.endsAt) : new Date(NaN);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) {
    return NextResponse.json({ error: "MAINTENANCE_WINDOW_INVALID" }, { status: 422 });
  }
  // AD-004 rules 13, 27, 40, 69, 76, 94: planned maintenance is a named
  // high-impact human operation — requires an AD-004 operation record
  // scoped to this app+environment before UL-004's own availability
  // authority runs (its 3900-second safe-start rule is untouched).
  const environment = (typeof body.environment === "string" ? body.environment : "production");
  if (typeof body.operationChangeId !== "string" || !body.operationChangeId) {
    return NextResponse.json({ error: "OPERATION_CHANGE_REQUIRED" }, { status: 400 });
  }
  try {
    requireOperationChangeForMutation({ operationChangeId: body.operationChangeId,
      allowedTypes: ["planned_maintenance", "emergency_availability_change"], environment, appId: params.appId });
    const result = await scheduleMaintenanceWindow({ appId: params.appId,
      environment: environment as "development" | "staging" | "production",
      startsAt, endsAt, reasonCategory: String(body.reasonCategory ?? ""),
      learnerMessage: typeof body.learnerMessage === "string" ? body.learnerMessage : null,
      expectedAvailabilityVersion: Number(body.expectedAvailabilityVersion),
      idempotencyKey: String(body.idempotencyKey ?? ""), actorId: guard.session.sub }, new Date());
    recordOperationOutcome(body.operationChangeId, guard.session.sub, "admin.app_availability.manage", "succeeded", params.appId);
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof OperationChangeError) {
      return NextResponse.json({ error: error.code },
        { status: operationChangeErrorStatus(error.code), headers: { "Cache-Control": "private, no-store" } });
    }
    if (error instanceof AppAvailabilityError) return NextResponse.json({ error: error.code },
      { status: appAvailabilityErrorStatus(error.code), headers: { "Cache-Control": "private, no-store" } });
    throw error;
  }
}
