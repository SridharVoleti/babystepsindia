import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { listJourney } from "@/lib/journey/service";
import { journeyRouteError } from "@/lib/journey/route-utils";

export async function GET(request: Request, { params }: { params: { learnerId: string; appId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.journey.read",
    { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  try {
    const url = new URL(request.url);
    const result = listJourney({ learnerId: params.learnerId, appId: params.appId,
      cursor: url.searchParams.get("cursor"),
      limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
      order: (url.searchParams.get("order") ?? undefined) as "asc" | "desc" | undefined,
      exposeRetentionDeadline: true });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) { return journeyRouteError(error); }
}

