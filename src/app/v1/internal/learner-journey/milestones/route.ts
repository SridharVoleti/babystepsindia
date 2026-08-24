import { NextResponse } from "next/server";
import { authorizeProtectedAppApi } from "@/lib/app-authorization/guard";
import { createJourneyMilestone, type CreateJourneyMilestoneInput } from "@/lib/journey/service";
import { journeyRouteError, strictJourneyObject } from "@/lib/journey/route-utils";

const fields = ["appJourneyMilestoneKey", "journeyInstanceKey", "title", "shortDescription", "iconAssetKey",
  "occurredAt", "basedOnProgressVersion", "sourceCompletionId", "sourceAchievementId", "idempotencyKey"];

export async function POST(request: Request) {
  try {
    const auth = await authorizeProtectedAppApi(request, "journey.milestone.write");
    const body = strictJourneyObject(await request.json(), fields) as CreateJourneyMilestoneInput;
    const result = await createJourneyMilestone({ learnerId: auth.learnerId, appId: auth.appId,
      releaseId: auth.releaseId, environment: auth.environment }, body, new Date());
    return NextResponse.json(result, { status: result.created ? 201 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return journeyRouteError(error); }
}

