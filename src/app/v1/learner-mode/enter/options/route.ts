import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { generatePasskeyAuthenticationOptions, WebAuthnError } from "@/lib/webauthn/service";

function failure(error: unknown) {
  const code = error instanceof WebAuthnError ? error.code : "LEARNER_MODE_ENTER_OPTIONS_FAILED";
  const status = code === "RESOURCE_NOT_FOUND" || code === "NO_PASSKEY_REGISTERED" ? 404 :
    code === "WEBAUTHN_NOT_CONFIGURED" ? 503 : 400;
  return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const guard = await requireEndUserAuthorization(request, "learner.mode.enter");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`learner-mode-enter-options:${guard.parent.session.sub}`, 20, 60_000))
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body || Object.keys(body).some((key) => key !== "learnerId") || typeof body.learnerId !== "string" || !body.learnerId)
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    const result = await generatePasskeyAuthenticationOptions({
      parentUserId: guard.parent.session.sub, parentSessionId: guard.parent.session.sid!,
      deviceSessionId: guard.authorization.deviceSessionId, learnerId: body.learnerId,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
