import { NextResponse } from "next/server";
import { requireAdminApi, requireReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AppAvailabilityError, appAvailabilityErrorStatus, scheduleMaintenanceWindow } from
  "@/lib/app-availability/service";

export async function POST(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.app_availability.manage");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`maintenance-window:${guard.session.sub}`, 30, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 }); }
  const reauthFailure = requireReauth(guard.session);
  if (reauthFailure) return reauthFailure;
  const startsAt = typeof body.startsAt === "string" ? new Date(body.startsAt) : new Date(NaN);
  const endsAt = typeof body.endsAt === "string" ? new Date(body.endsAt) : new Date(NaN);
  if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) {
    return NextResponse.json({ error: "MAINTENANCE_WINDOW_INVALID" }, { status: 422 });
  }
  try {
    const result = scheduleMaintenanceWindow({ appId: params.appId,
      environment: (typeof body.environment === "string" ? body.environment : "production") as
        "development" | "staging" | "production",
      startsAt, endsAt, reasonCategory: String(body.reasonCategory ?? ""),
      learnerMessage: typeof body.learnerMessage === "string" ? body.learnerMessage : null,
      expectedAvailabilityVersion: Number(body.expectedAvailabilityVersion),
      idempotencyKey: String(body.idempotencyKey ?? ""), actorId: guard.session.sub }, new Date());
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AppAvailabilityError) return NextResponse.json({ error: error.code },
      { status: appAvailabilityErrorStatus(error.code), headers: { "Cache-Control": "private, no-store" } });
    throw error;
  }
}
