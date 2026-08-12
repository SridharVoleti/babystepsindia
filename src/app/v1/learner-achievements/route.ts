import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { listAchievements } from "@/lib/achievements/service";
import { achievementRouteError } from "@/lib/achievements/route-utils";

export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "learner.achievements.read");
  if (!guard.ok) return guard.response;
  try {
    const url = new URL(request.url);
    const result = listAchievements({ learnerId: guard.authorization.learnerId!,
      cursor: url.searchParams.get("cursor"), limit: url.searchParams.has("limit")
        ? Number(url.searchParams.get("limit")) : undefined, appId: url.searchParams.get("appId"),
      category: url.searchParams.get("category") });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) {
    return achievementRouteError(error);
  }
}
