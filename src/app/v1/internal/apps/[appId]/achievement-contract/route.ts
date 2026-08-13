import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { getReleaseAchievementContract } from "@/lib/achievements/service";
import { achievementRouteError, authorizeAppPrincipalAssertion } from "@/lib/achievements/route-utils";

export async function GET(request: Request, { params }: { params: { appId: string } }) {
  try {
    const principal = authorizeAppPrincipalAssertion(request);
    const url = new URL(request.url);
    const releaseId = url.searchParams.get("releaseId") ?? "";
    const environment = url.searchParams.get("environment") ?? "";
    if (principal.app_id !== params.appId || principal.environment !== environment) {
      return NextResponse.json({ error: "AUTHORIZATION_DENIED" }, { status: 403,
        headers: { "Cache-Control": "no-store" } });
    }
    const binding = getDb().prepare(`select release_id from app_deployment_launch_controls
      where deployment_id=? and app_id=? and environment=?`).get(principal.deployment_id, params.appId, environment) as
      { release_id: string } | undefined;
    if (!binding || binding.release_id !== releaseId) {
      return NextResponse.json({ error: "AUTHORIZATION_DENIED" }, { status: 403,
        headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(getReleaseAchievementContract(params.appId, releaseId),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return achievementRouteError(error);
  }
}
