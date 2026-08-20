import { NextResponse } from "next/server";
import { authorizeProtectedAppApi } from "@/lib/app-authorization/guard";
import { getSessionExitState, SessionExitError } from "@/lib/session-exit/service";
import { lifecycleError } from "@/lib/session-finalization/route-utils";

export async function GET(request: Request, { params }: { params: { sessionId: string } }) {
  try {
    const auth = await authorizeProtectedAppApi(request, "session.exit");
    if (auth.learnerSessionId !== params.sessionId) {
      throw new SessionExitError("LEARNER_SESSION_BINDING_MISMATCH");
    }
    return NextResponse.json(await getSessionExitState(auth, new Date()), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return lifecycleError(error);
  }
}
