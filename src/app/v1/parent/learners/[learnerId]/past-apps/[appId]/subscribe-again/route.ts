import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { resolveSubscribeAgainContinuation } from "@/lib/learner-home/subscribe-again";
import { LearnerHomeError } from "@/lib/learner-home/past-apps";

export async function POST(request: Request, { params }: { params: { learnerId: string; appId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.subscribe_again.create", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  try {
    const result = await resolveSubscribeAgainContinuation(guard.parent.session.sub, params.learnerId, params.appId, new Date());
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const code = error instanceof LearnerHomeError ? error.code : "SUBSCRIBE_AGAIN_FAILED";
    return NextResponse.json({ error: code }, { status: code === "RESOURCE_NOT_FOUND" ? 404 : 400,
      headers: { "Cache-Control": "no-store" } });
  }
}
