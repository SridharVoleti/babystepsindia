import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { generatePasskeyRegistrationOptions, WebAuthnError } from "@/lib/webauthn/service";

function failure(error: unknown) {
  const code = error instanceof WebAuthnError ? error.code : "PASSKEY_REGISTRATION_OPTIONS_FAILED";
  const status = code === "RESOURCE_NOT_FOUND" ? 404 : code === "WEBAUTHN_NOT_CONFIGURED" ? 503 : 400;
  return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: { learnerId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.passkeys.manage", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`passkey-reg-options:${guard.parent.session.sub}`, 20, 60_000))
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  try {
    const result = await generatePasskeyRegistrationOptions({
      parentUserId: guard.parent.session.sub, parentSessionId: guard.parent.session.sid!,
      deviceSessionId: guard.authorization.deviceSessionId, learnerId: params.learnerId,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
