import { NextResponse } from "next/server";
import { authorizeProtectedAppApi } from "@/lib/app-authorization/guard";
import { disconnectLearnerSession, LearnerSessionError } from "@/lib/learning-session/gateway";
import { lifecycleError } from "@/lib/session-finalization/route-utils";

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  try {
    const auth = await authorizeProtectedAppApi(request, "session.usable_launch");
    if (auth.learnerSessionId !== params.sessionId) throw new LearnerSessionError("LEARNER_SESSION_BINDING_MISMATCH");
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (Object.keys(body).some((key) => key !== "reportedConnectedSeconds") ||
        (body.reportedConnectedSeconds !== undefined && !Number.isFinite(body.reportedConnectedSeconds))) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    const result = disconnectLearnerSession(auth, {
      reportedConnectedSeconds: body.reportedConnectedSeconds as number | undefined, now: new Date(),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return lifecycleError(error); }
}
