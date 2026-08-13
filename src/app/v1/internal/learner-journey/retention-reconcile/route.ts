import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { reconcileJourney } from "@/lib/journey/service";
import { journeyRouteError, strictJourneyObject } from "@/lib/journey/route-utils";

const fields = ["mode", "learnerId", "cursor", "limit", "runIdempotencyKey"];

export async function POST(request: Request) {
  const guard = await requireInternalService(request, "journey-retention");
  if (!guard.ok) return guard.response;
  try {
    const body = strictJourneyObject(await request.json(), fields);
    if (!["lifecycle", "reconcile", "purge"].includes(String(body.mode))) {
      return NextResponse.json({ error: "JOURNEY_RECONCILE_INVALID" }, { status: 400,
        headers: { "Cache-Control": "no-store" } });
    }
    const result = reconcileJourney({ mode: body.mode as "lifecycle" | "reconcile" | "purge",
      learnerId: body.learnerId as string | null | undefined, cursor: body.cursor as string | null | undefined,
      limit: Number(body.limit), runIdempotencyKey: String(body.runIdempotencyKey),
      principalId: guard.principal.id, now: new Date() });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return journeyRouteError(error); }
}
