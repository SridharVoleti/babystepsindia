import { NextResponse } from "next/server";
import { achievementRouteError, authorizeAppPrincipalAssertion, strictAchievementObject }
  from "@/lib/achievements/route-utils";
import { revokeAchievement, type RevokeAchievementInput } from "@/lib/achievements/service";

const fields = ["expectedRecordVersion", "reasonCode", "idempotencyKey"] as const;

export async function POST(request: Request, { params }: { params: { achievementId: string } }) {
  try {
    const principal = authorizeAppPrincipalAssertion(request);
    const body = strictAchievementObject(await request.json(), fields) as unknown as RevokeAchievementInput;
    const result = revokeAchievement({ achievementId: params.achievementId, appId: principal.app_id,
      environment: principal.environment, principalId: principal.id, request: body, now: new Date() });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return achievementRouteError(error);
  }
}
