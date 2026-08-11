import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { reconcileLauncherFreshness, LauncherFreshnessError, launcherFreshnessErrorStatus } from
  "@/lib/learner-home/freshness-service";

export async function POST(request: Request) {
  const guard = await requireInternalService(request, "launcher-reconciliation");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  if (typeof body.limit !== "number" || typeof body.runIdempotencyKey !== "string"
    || (body.learnerId !== undefined && typeof body.learnerId !== "string")
    || (body.appId !== undefined && typeof body.appId !== "string")
    || (body.environment !== undefined && typeof body.environment !== "string")
    || (body.from !== undefined && typeof body.from !== "string")
    || (body.to !== undefined && typeof body.to !== "string")
    || (body.cursor !== undefined && typeof body.cursor !== "string")) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const result = reconcileLauncherFreshness(guard.principal.id, {
      learnerId: body.learnerId as string | undefined, appId: body.appId as string | undefined,
      environment: (body.environment as string | undefined) ?? "production",
      from: body.from as string | undefined, to: body.to as string | undefined,
      cursor: body.cursor as string | undefined, limit: body.limit, runIdempotencyKey: body.runIdempotencyKey,
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
