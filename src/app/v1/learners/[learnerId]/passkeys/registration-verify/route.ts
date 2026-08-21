import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { verifyPasskeyRegistration, WebAuthnError } from "@/lib/webauthn/production-gateway";

function failure(error: unknown) {
  const code = error instanceof WebAuthnError ? error.code : "PASSKEY_REGISTRATION_VERIFY_FAILED";
  const status = code === "RESOURCE_NOT_FOUND" ? 404 : code === "WEBAUTHN_NOT_CONFIGURED" ? 503 :
    code === "WEBAUTHN_CHALLENGE_INVALID" ? 409 : 400;
  return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: { learnerId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.passkeys.manage", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`passkey-reg-verify:${guard.parent.session.sub}`, 20, 60_000))
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body || Object.keys(body).some((key) => !["challengeId", "response", "label"].includes(key)) ||
        typeof body.challengeId !== "string" || !body.challengeId ||
        typeof body.label !== "string" || !body.label.trim() || body.label.length > 60 ||
        !body.response || typeof body.response !== "object")
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    const now = new Date();
    const result = await verifyPasskeyRegistration({
      parentUserId: guard.parent.session.sub, parentSessionId: guard.parent.session.sid!,
      deviceSessionId: guard.authorization.deviceSessionId, learnerId: params.learnerId,
      challengeId: body.challengeId, label: body.label.trim(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: body.response as any,
    }, now);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
