import { NextResponse } from "next/server";
import { requireAdminApi, requireReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AppAvailabilityError, appAvailabilityErrorStatus, updateMaintenanceWindow } from
  "@/lib/app-availability/service";

export async function PATCH(request: Request,
  { params }: { params: { appId: string; windowId: string } }) {
  const guard = await requireAdminApi("admin.app_availability.manage");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`maintenance-window:${guard.session.sub}`, 30, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 }); }
  const reauthFailure = await requireReauth(guard.session);
  if (reauthFailure) return reauthFailure;
  const startsAt = typeof body.startsAt === "string" ? new Date(body.startsAt) : undefined;
  const endsAt = typeof body.endsAt === "string" ? new Date(body.endsAt) : undefined;
  if ((startsAt && !Number.isFinite(startsAt.getTime())) || (endsAt && !Number.isFinite(endsAt.getTime()))) {
    return NextResponse.json({ error: "MAINTENANCE_WINDOW_INVALID" }, { status: 422 });
  }
  try {
    const result = updateMaintenanceWindow({ appId: params.appId, windowId: params.windowId,
      environment: (typeof body.environment === "string" ? body.environment : "production") as
        "development" | "staging" | "production",
      action: body.action === "cancel" ? "cancel" : "update", startsAt, endsAt,
      reasonCategory: typeof body.reasonCategory === "string" ? body.reasonCategory : undefined,
      learnerMessage: typeof body.learnerMessage === "string" || body.learnerMessage === null
        ? body.learnerMessage as string | null : undefined,
      expectedAvailabilityVersion: Number(body.expectedAvailabilityVersion),
      expectedWindowVersion: Number(body.expectedWindowVersion), idempotencyKey: String(body.idempotencyKey ?? ""),
      actorId: guard.session.sub }, new Date());
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AppAvailabilityError) return NextResponse.json({ error: error.code },
      { status: appAvailabilityErrorStatus(error.code), headers: { "Cache-Control": "private, no-store" } });
    throw error;
  }
}
