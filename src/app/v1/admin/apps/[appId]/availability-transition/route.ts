import { NextResponse } from "next/server";
import { requireAdminApi, requireReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AppAvailabilityError, appAvailabilityErrorStatus, transitionAvailability } from
  "@/lib/app-availability/service";

export async function POST(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.app_availability.manage");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`availability-transition:${guard.session.sub}`, 30, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 }); }
  const reauthFailure = await requireReauth(guard.session);
  if (reauthFailure) return reauthFailure;
  if (!["available", "temporarily_unavailable", "restoring"].includes(String(body.targetState))) {
    return NextResponse.json({ error: "APP_AVAILABILITY_STATE_INVALID" }, { status: 422 });
  }
  const expectedReturnAt = typeof body.expectedReturnAt === "string" ? new Date(body.expectedReturnAt) : null;
  if (expectedReturnAt && !Number.isFinite(expectedReturnAt.getTime())) {
    return NextResponse.json({ error: "APP_AVAILABILITY_STATE_INVALID" }, { status: 422 });
  }
  try {
    const result = await transitionAvailability({ appId: params.appId,
      environment: (typeof body.environment === "string" ? body.environment : "production") as
        "development" | "staging" | "production",
      targetState: body.targetState as "available" | "temporarily_unavailable" | "restoring",
      reasonCategory: String(body.reasonCategory ?? ""),
      learnerMessage: typeof body.learnerMessage === "string" ? body.learnerMessage : null,
      expectedReturnAt, expectedAvailabilityVersion: Number(body.expectedAvailabilityVersion),
      idempotencyKey: String(body.idempotencyKey ?? ""), actorId: guard.session.sub }, new Date());
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof AppAvailabilityError) return NextResponse.json({ error: error.code },
      { status: appAvailabilityErrorStatus(error.code), headers: { "Cache-Control": "private, no-store" } });
    throw error;
  }
}
