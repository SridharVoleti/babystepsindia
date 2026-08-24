import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { listConsistency } from "@/lib/consistency/service";
import { consistencyRouteError } from "@/lib/consistency/route-utils";

export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "learner.consistency.read");
  if (!guard.ok) return guard.response;
  try {
    const url = new URL(request.url);
    const result = await listConsistency({ learnerId: guard.authorization.learnerId!,
      cursor: url.searchParams.get("cursor"), appId: url.searchParams.get("appId"),
      limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
  } catch (error) { return consistencyRouteError(error); }
}
