import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { invalidateLauncherFreshness, LauncherFreshnessError, launcherFreshnessErrorStatus } from
  "@/lib/learner-home/freshness-service";

export async function POST(request: Request) {
  const guard = await requireInternalService(request, "launcher-domain-outbox");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (typeof body.learnerId !== "string" || typeof body.sourceType !== "string"
    || (typeof body.sourceVersion !== "string" && typeof body.sourceVersion !== "number")
    || typeof body.eventId !== "string" || (body.appId !== undefined && typeof body.appId !== "string")
    || (body.environment !== undefined && typeof body.environment !== "string")) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const result = await invalidateLauncherFreshness(guard.principal.id, {
      learnerId: body.learnerId, appId: body.appId as string | undefined,
      environment: (body.environment as string | undefined) ?? "production",
      sourceType: body.sourceType, sourceVersion: body.sourceVersion, eventId: body.eventId,
    }, new Date());
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof LauncherFreshnessError) {
      return NextResponse.json({ error: error.code }, { status: launcherFreshnessErrorStatus(error.code),
        headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
