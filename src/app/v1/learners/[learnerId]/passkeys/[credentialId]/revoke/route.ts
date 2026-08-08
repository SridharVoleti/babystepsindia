import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";
import { revokeLearnerPasskey, WebAuthnError } from "@/lib/webauthn/service";

export async function POST(request: Request, { params }: { params: { learnerId: string; credentialId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.passkeys.manage", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`passkey-revoke:${guard.parent.session.sub}`, 10, 60_000))
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body || Object.keys(body).some((key) => key !== "currentPassword") || typeof body.currentPassword !== "string")
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    const verified = await sqliteAuthAdapter.signInWithPassword(guard.parent.user.email, body.currentPassword);
    if (!verified) return NextResponse.json({ error: "PARENT_REAUTHENTICATION_REQUIRED" }, { status: 403 });
    const result = withLockedEndUserMutation({ preflight: guard.authorization, action: "parent.passkeys.manage",
      resource: { learnerId: params.learnerId }, mutate: () => revokeLearnerPasskey({
        parentUserId: guard.parent.session.sub, learnerId: params.learnerId, credentialRowId: params.credentialId,
        parentPasswordReauthenticated: true, now: new Date(),
      }) });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof WebAuthnError ? error.code : "PASSKEY_REVOKE_FAILED";
    const status = code === "RESOURCE_NOT_FOUND" ? 404 : code === "PARENT_REAUTHENTICATION_REQUIRED" ? 403 : 400;
    return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
