import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { evaluateAccessForLauncher } from "@/lib/entitlement-access/launcher-cache";
import { listJourney } from "@/lib/journey/service";
import { journeyRouteError } from "@/lib/journey/route-utils";

export async function GET(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireEndUserAuthorization(request, "learner.journey.read");
  if (!guard.ok) return guard.response;
  try {
    const learnerId = guard.authorization.learnerId!;
    const decision = evaluateAccessForLauncher({ learnerId, appId: params.appId,
      environment: "production", now: new Date() });
    if (!decision.allowed || !["active", "grace"].includes(decision.state)) {
      return NextResponse.json({ error: "JOURNEY_NOT_FOUND" }, { status: 404,
        headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
    }
    const url = new URL(request.url);
    const result = listJourney({ learnerId, appId: params.appId, cursor: url.searchParams.get("cursor"),
      limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
      order: (url.searchParams.get("order") ?? undefined) as "asc" | "desc" | undefined });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) { return journeyRouteError(error); }
}

