import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { ConsistencyError } from "@/lib/consistency/service";
import { consistencyRouteError } from "@/lib/consistency/route-utils";
import { readCadenceCompletionContext } from "@/lib/cadence-celebration/service";

export async function GET(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireInternalService(request, "consistency-session-domain");
  if (!guard.ok) return guard.response;
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((key) => key !== "sessionId")) {
      throw new ConsistencyError("CONSISTENCY_REQUEST_INVALID");
    }
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || url.searchParams.getAll("sessionId").length !== 1) {
      throw new ConsistencyError("CONSISTENCY_REQUEST_INVALID");
    }
    return NextResponse.json(await readCadenceCompletionContext(params.appId, sessionId),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return consistencyRouteError(error); }
}
