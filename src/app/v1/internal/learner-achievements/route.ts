import { NextResponse } from "next/server";
import { authorizeProtectedAppApi } from "@/lib/app-authorization/guard";
import { createAchievement, type CreateAchievementInput } from "@/lib/achievements/service";
import { achievementRouteError, strictAchievementObject } from "@/lib/achievements/route-utils";

const fields = ["achievementContractVersion", "appAchievementKey", "achievementInstanceKey", "title",
  "shortDescription", "badgeAssetKey", "category", "earnedAt", "appAchievementModelVersion",
  "sourceProgressVersion", "sourceCompletionId", "sourceSessionId", "idempotencyKey"] as const;

export async function POST(request: Request) {
  try {
    const context = await authorizeProtectedAppApi(request, "achievement.write");
    const body = strictAchievementObject(await request.json(), fields) as unknown as CreateAchievementInput;
    const result = await createAchievement(context, body, new Date());
    return NextResponse.json(result, { status: result.created ? 201 : 200,
      headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return achievementRouteError(error);
  }
}
