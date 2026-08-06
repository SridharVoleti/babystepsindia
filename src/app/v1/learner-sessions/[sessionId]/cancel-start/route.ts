import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { cancelStartReservation, LearnerSessionError } from "@/lib/learning-session/gateway";
import { lifecycleError } from "@/lib/session-finalization/route-utils";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";

export async function POST(request: Request, { params }: { params: { sessionId: string } }) {
  const guard = await requireEndUserAuthorization(request, "learner.session.cancel_start");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`cancel-start:${guard.parent.session.sub}:${params.sessionId}`, 10, 60_000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body || Object.keys(body).some((key) => key !== "expectedSessionVersion") ||
        !Number.isInteger(body.expectedSessionVersion)) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    if (!guard.authorization.learnerId) throw new LearnerSessionError("LEARNER_SESSION_BINDING_MISMATCH");
    const learnerId = guard.authorization.learnerId;
    return NextResponse.json(withLockedEndUserMutation({ preflight: guard.authorization,
      action: "learner.session.cancel_start", resource: { learnerId },
      mutate: () => cancelStartReservation({ learnerId, parentUserId: guard.parent.session.sub },
        params.sessionId, { expectedSessionVersion: body.expectedSessionVersion as number, now: new Date() }) }),
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return lifecycleError(error); }
}
