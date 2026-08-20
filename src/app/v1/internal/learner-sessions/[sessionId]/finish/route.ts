import { NextResponse } from "next/server";
import { authorizeProtectedAppApi } from "@/lib/app-authorization/guard";
import { finishSessionIntentionally, SessionExitError } from "@/lib/session-exit/service";
import { lifecycleError } from "@/lib/session-finalization/route-utils";
import { composeCadenceCelebrationAfterCommit } from "@/lib/cadence-celebration/service";

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  try {
    const auth = await authorizeProtectedAppApi(request, "session.complete");
    if (auth.learnerSessionId !== params.sessionId) {
      throw new SessionExitError("LEARNER_SESSION_BINDING_MISMATCH");
    }
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const allowed = ["expectedSessionVersion", "finalProgressVersion", "reason", "idempotencyKey"];
    if (!body || Object.keys(body).some((key) => !allowed.includes(key)) ||
        !Number.isInteger(body.expectedSessionVersion) || !Number.isInteger(body.finalProgressVersion) ||
        body.reason !== "intentional_finish" || typeof body.idempotencyKey !== "string" || !body.idempotencyKey) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    const result = await finishSessionIntentionally(auth, body as never, new Date());
    return NextResponse.json(await composeCadenceCelebrationAfterCommit(auth, body.idempotencyKey, result),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return lifecycleError(error);
  }
}
