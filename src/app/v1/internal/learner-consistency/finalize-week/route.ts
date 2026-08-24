import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { ConsistencyError, finalizeConsistencyWeek } from "@/lib/consistency/service";
import { consistencyRouteError, strictConsistencyObject } from "@/lib/consistency/route-utils";

export async function POST(request: Request) {
  const guard = await requireInternalService(request, "consistency-scheduler");
  if (!guard.ok) return guard.response;
  try {
    const body = strictConsistencyObject(await request.json(),
      ["weeklyKey", "environment", "cursor", "limit", "runIdempotencyKey"]);
    if (typeof body.weeklyKey !== "string" || typeof body.limit !== "number"
      || typeof body.runIdempotencyKey !== "string"
      || (body.environment !== undefined && typeof body.environment !== "string")
      || (body.cursor !== undefined && typeof body.cursor !== "string")) throw new ConsistencyError("CONSISTENCY_REQUEST_INVALID");
    const result = await finalizeConsistencyWeek({ weeklyKey: body.weeklyKey,
      environment: body.environment as string | undefined, cursor: body.cursor as string | undefined,
      limit: body.limit, runIdempotencyKey: body.runIdempotencyKey, principalId: guard.principal.id });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return consistencyRouteError(error); }
}
