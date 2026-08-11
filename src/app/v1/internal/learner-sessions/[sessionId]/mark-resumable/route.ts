import { NextResponse } from "next/server";
import { authorizeProtectedAppApi } from "@/lib/app-authorization/guard";
import { markSessionResumable, SessionExitError } from "@/lib/session-exit/service";
import { lifecycleError } from "@/lib/session-finalization/route-utils";

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  try {
    const auth = await authorizeProtectedAppApi(request, "session.exit");
    if (auth.learnerSessionId !== params.sessionId) {
      throw new SessionExitError("LEARNER_SESSION_BINDING_MISMATCH");
    }
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const allowed = ["expectedSessionVersion", "lastAcknowledgedProgressVersion", "idempotencyKey"];
    if (!body || Object.keys(body).some((key) => !allowed.includes(key)) ||
        !Number.isInteger(body.expectedSessionVersion) || !Number.isInteger(body.lastAcknowledgedProgressVersion) ||
        typeof body.idempotencyKey !== "string" || !body.idempotencyKey) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    const result = markSessionResumable(auth, body as never, new Date());
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return lifecycleError(error);
  }
}
