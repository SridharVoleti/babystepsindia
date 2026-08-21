import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { listLearnerPasskeys, WebAuthnError } from "@/lib/webauthn/production-gateway";

export async function GET(request: Request, { params }: { params: { learnerId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.passkeys.manage", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json({ passkeys: await listLearnerPasskeys(guard.parent.session.sub, params.learnerId) },
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const code = error instanceof WebAuthnError ? error.code : "PASSKEYS_LIST_FAILED";
    return NextResponse.json({ error: code }, { status: code === "RESOURCE_NOT_FOUND" ? 404 : 400,
      headers: { "Cache-Control": "no-store" } });
  }
}
