import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { ConsistencyError, reconcileConsistency } from "@/lib/consistency/service";
import { consistencyRouteError, strictConsistencyObject } from "@/lib/consistency/route-utils";

export async function POST(request: Request) {
  const guard = await requireInternalService(request, "consistency-reconciliation");
  if (!guard.ok) return guard.response;
  try {
    const body = strictConsistencyObject(await request.json(),
      ["learnerId", "appId", "environment", "fromWeek", "toWeek", "cursor", "limit", "runIdempotencyKey"]);
    if (typeof body.limit !== "number" || typeof body.runIdempotencyKey !== "string"
      || ["learnerId", "appId", "environment", "fromWeek", "toWeek", "cursor"]
        .some((key) => body[key] !== undefined && typeof body[key] !== "string")) {
      throw new ConsistencyError("CONSISTENCY_REQUEST_INVALID");
    }
    const result = await reconcileConsistency({ learnerId: body.learnerId as string | undefined,
      appId: body.appId as string | undefined, environment: body.environment as string | undefined,
      fromWeek: body.fromWeek as string | undefined, toWeek: body.toWeek as string | undefined,
      cursor: body.cursor as string | undefined, limit: body.limit,
      runIdempotencyKey: body.runIdempotencyKey, principalId: guard.principal.id });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return consistencyRouteError(error); }
}
