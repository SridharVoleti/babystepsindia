import { NextResponse } from "next/server";
import { authorizeProtectedAppApi } from "@/lib/app-authorization/guard";
import { resumeLearnerSession, LearnerSessionError } from "@/lib/learning-session/gateway";
import { lifecycleError } from "@/lib/session-finalization/route-utils";

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  try {
    const auth = await authorizeProtectedAppApi(request, "session.heartbeat");
    if (auth.learnerSessionId !== params.sessionId) throw new LearnerSessionError("LEARNER_SESSION_BINDING_MISMATCH");
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const allowed = ["deviceSessionId", "credential"];
    if (Object.keys(body).some((key) => !allowed.includes(key)) ||
        typeof body.deviceSessionId !== "string" || !body.deviceSessionId ||
        typeof body.credential !== "string" || !body.credential) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    const result = resumeLearnerSession(auth, {
      deviceSessionId: body.deviceSessionId, credential: body.credential, now: new Date(),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return lifecycleError(error); }
}
