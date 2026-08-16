import { NextResponse } from "next/server";
import { issueBreakGlassRecoverySession } from "@/lib/platform-governance/recovery-sessions";
import { PlatformGovernanceError, platformGovernanceErrorStatus } from "@/lib/platform-governance/contracts";

// API-AD-028: pre-MFA, self-service by the target — no staff session
// exists yet. Requires the target's existing password plus one unused
// recovery code, and only when the server confirms no different active
// Platform Administrator exists (rule 57). Returns an enrollment session
// only, never an admin session/role/status change (rules 59-63).
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (
    typeof body.email !== "string" || typeof body.password !== "string" ||
    typeof body.recoveryCode !== "string" || !body.recoveryCode.trim()
  ) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = await issueBreakGlassRecoverySession({ email: body.email, password: body.password, recoveryCode: body.recoveryCode });
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformGovernanceError) {
      return NextResponse.json({ error: error.code }, { status: platformGovernanceErrorStatus(error.code) });
    }
    throw error;
  }
}
