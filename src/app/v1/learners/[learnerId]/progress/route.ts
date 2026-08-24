import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { getOwnedLearnerProgressReport } from "@/lib/db/learner-progress-repo";

export async function GET(request: Request, { params }: { params: { learnerId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.report.read",
    { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  return NextResponse.json({ learnerId: params.learnerId,
    apps: await getOwnedLearnerProgressReport(guard.parent.session.sub, params.learnerId) },
  { headers: { "Cache-Control": "private, no-store" } });
}
