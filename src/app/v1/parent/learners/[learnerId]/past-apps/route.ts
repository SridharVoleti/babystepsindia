import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { listPastApps, LearnerHomeError } from "@/lib/learner-home/past-apps";

export async function GET(request: Request, { params }: { params: { learnerId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.past_apps.read", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json({ learnerId: params.learnerId,
      pastApps: listPastApps(guard.parent.session.sub, params.learnerId, new Date()) },
    { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const code = error instanceof LearnerHomeError ? error.code : "PAST_APPS_LIST_FAILED";
    return NextResponse.json({ error: code }, { status: code === "RESOURCE_NOT_FOUND" ? 404 : 400,
      headers: { "Cache-Control": "no-store" } });
  }
}
