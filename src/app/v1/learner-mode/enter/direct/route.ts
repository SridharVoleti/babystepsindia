import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AuthorizationModeError, enterLearnerModeDirectly } from "@/lib/authorization/modes";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { selectLearner, LearnerSessionError } from "@/lib/learning-session/gateway";

function failure(error: unknown) {
  const code = error instanceof AuthorizationModeError ? error.code :
    error instanceof LearnerSessionError ? error.code : "LEARNER_MODE_ENTER_DIRECT_FAILED";
  const status = code === "RESOURCE_NOT_FOUND" ? 404 :
    code === "FRESH_LOGIN_REQUIRED" ? 401 :
    code === "LEARNER_PROFILE_LOCKED" ? 403 : 400;
  return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
}

// Learners no longer need a registered passkey to enter learner mode — this
// mirrors /v1/learner-mode/enter/options + /verify (same guard, same
// selectLearner call establishing the selection context activateLearnerMode
// requires) but skips the WebAuthn ceremony via enterLearnerModeDirectly.
export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "learner.mode.enter");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`learner-mode-enter-direct:${guard.parent.session.sub}`, 20, 60_000))
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body || Object.keys(body).some((key) => key !== "learnerId") || typeof body.learnerId !== "string" || !body.learnerId)
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    const session = guard.parent.session;
    if (!session.sid || !session.exp) throw new LearnerSessionError("FRESH_LOGIN_REQUIRED");
    await selectLearner(session.sid, session.sub, body.learnerId, new Date(session.exp * 1000).toISOString());
    const context = await enterLearnerModeDirectly({
      parentUserId: session.sub, parentSessionId: session.sid, deviceSessionId: guard.authorization.deviceSessionId,
      learnerId: body.learnerId, expiresAt: new Date(session.exp * 1000), now: new Date(),
    });
    return NextResponse.json(context, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
