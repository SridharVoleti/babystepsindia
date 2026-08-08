import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AuthorizationModeError } from "@/lib/authorization/modes";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { verifyPasskeyAuthenticationAndEnterLearnerMode, WebAuthnError } from "@/lib/webauthn/service";

function failure(error: unknown) {
  const code = error instanceof WebAuthnError ? error.code :
    error instanceof AuthorizationModeError ? error.code : "LEARNER_MODE_ENTER_VERIFY_FAILED";
  const status = code === "RESOURCE_NOT_FOUND" ? 404 :
    code === "WEBAUTHN_CHALLENGE_INVALID" ? 409 :
    code === "WEBAUTHN_AUTHENTICATION_INVALID" || code === "WEBAUTHN_CLONE_SUSPECTED" ||
      code === "LEARNER_PROFILE_LOCKED" ? 403 : 400;
  return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "learner.mode.enter");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`learner-mode-enter-verify:${guard.parent.session.sub}`, 20, 60_000))
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body || Object.keys(body).some((key) => !["learnerId", "challengeId", "response"].includes(key)) ||
        typeof body.learnerId !== "string" || !body.learnerId ||
        typeof body.challengeId !== "string" || !body.challengeId ||
        !body.response || typeof body.response !== "object")
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    const context = await verifyPasskeyAuthenticationAndEnterLearnerMode({
      parentUserId: guard.parent.session.sub, parentSessionId: guard.parent.session.sid!,
      deviceSessionId: guard.authorization.deviceSessionId, learnerId: body.learnerId,
      challengeId: body.challengeId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: body.response as any,
    });
    return NextResponse.json(context, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
