import { NextResponse } from "next/server";
import { consumeDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { reauthenticateAuthoritativeParent } from "@/lib/account/supabase-account-security";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { revokeLearnerPasskey, WebAuthnError } from "@/lib/webauthn/production-gateway";

// Postgres transactions replace the legacy withLockedEndUserMutation SQLite boundary.

export async function POST(request: Request, { params }: { params: { learnerId: string; credentialId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.passkeys.manage", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  if (!(await consumeDistributedRateLimit({ key: `passkey-revoke:${guard.parent.session.sub}`, limit: 10, windowMs: 60_000 })))
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  try {
    const body = await request.json() as Record<string, unknown>;
    if (!body || Object.keys(body).some((key) => key !== "currentPassword") || typeof body.currentPassword !== "string")
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    const verified = await reauthenticateAuthoritativeParent(guard.parent.user.email, body.currentPassword);
    if (!verified) return NextResponse.json({ error: "PARENT_REAUTHENTICATION_REQUIRED" }, { status: 403 });
    const result = await revokeLearnerPasskey({
        parentUserId: guard.parent.session.sub, learnerId: params.learnerId, credentialRowId: params.credentialId,
        parentPasswordReauthenticated: true, now: new Date(),
      });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof WebAuthnError ? error.code : "PASSKEY_REVOKE_FAILED";
    const status = code === "RESOURCE_NOT_FOUND" ? 404 : code === "PARENT_REAUTHENTICATION_REQUIRED" ? 403 : 400;
    return NextResponse.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
