import { NextResponse } from "next/server";
import { authorizeProtectedAppApi } from "@/lib/app-authorization/guard";
import { confirmUsableLaunch, LearnerSessionError } from "@/lib/learning-session/gateway";
import { lifecycleError } from "@/lib/session-finalization/route-utils";

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  try {
    const auth = await authorizeProtectedAppApi(request, "session.usable_launch");
    if (auth.learnerSessionId !== params.sessionId) throw new LearnerSessionError("LEARNER_SESSION_BINDING_MISMATCH");
    const body = await request.json() as Record<string, unknown>;
    const allowed = ["runtimeInitializationId", "runtimeVersion", "expectedSessionVersion", "idempotencyKey"];
    if (!body || Object.keys(body).some((key) => !allowed.includes(key)) ||
        typeof body.runtimeInitializationId !== "string" || !body.runtimeInitializationId ||
        !Number.isInteger(body.runtimeVersion) || !Number.isInteger(body.expectedSessionVersion) ||
        typeof body.idempotencyKey !== "string" || !body.idempotencyKey) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    const result = await confirmUsableLaunch(auth, { runtimeInitializationId: body.runtimeInitializationId,
      runtimeVersion: body.runtimeVersion as number, expectedSessionVersion: body.expectedSessionVersion as number,
      idempotencyKey: body.idempotencyKey, now: new Date() });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return lifecycleError(error); }
}
