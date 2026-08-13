import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { applyStandardSessionConsistency, ConsistencyError } from "@/lib/consistency/service";
import { consistencyRouteError, strictConsistencyObject } from "@/lib/consistency/route-utils";

export async function POST(request: Request) {
  const guard = await requireInternalService(request, "consistency-session-domain");
  if (!guard.ok) return guard.response;
  try {
    const body = strictConsistencyObject(await request.json(), ["sourceSessionId", "weeklyUsageVersion", "eventId"]);
    if (typeof body.sourceSessionId !== "string" || !Number.isInteger(body.weeklyUsageVersion)
      || typeof body.eventId !== "string") throw new ConsistencyError("CONSISTENCY_REQUEST_INVALID");
    const result = applyStandardSessionConsistency({ sourceSessionId: body.sourceSessionId,
      weeklyUsageVersion: body.weeklyUsageVersion as number, eventId: body.eventId,
      principalId: guard.principal.id, now: new Date() });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return consistencyRouteError(error); }
}
