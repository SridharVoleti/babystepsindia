import { NextResponse } from "next/server";
import { consumeRecoverySessionWithPassword } from "@/lib/platform-governance/recovery-sessions";
import { PlatformGovernanceError, platformGovernanceErrorStatus } from "@/lib/platform-governance/contracts";

// Target-facing step for a NORMAL (admin-issued) recovery session — rule
// 42: the target still proves their existing password before the
// recovery session can be exchanged for a passkey-registration
// pendingToken, even though a different Platform Administrator already
// vouched for the request via API-AD-027.
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.email !== "string" || typeof body.password !== "string") {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = await consumeRecoverySessionWithPassword({ email: body.email, password: body.password });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformGovernanceError) {
      return NextResponse.json({ error: error.code }, { status: platformGovernanceErrorStatus(error.code) });
    }
    throw error;
  }
}
