import { NextResponse } from "next/server";
import { requireAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";
import { staffFailure } from "@/lib/staff-identity/route-helpers";
import { issueNormalRecoverySession } from "@/lib/platform-governance/recovery-sessions";
import { PlatformGovernanceError, platformGovernanceErrorStatus } from "@/lib/platform-governance/contracts";

// API-AD-027: a DIFFERENT active Platform Administrator + <=10m two-factor
// reauth issues a 30-minute target-bound passkey-recovery enrollment
// session — never itself an MFA admin session or a role/status change.
export async function POST(request: Request, { params }: { params: { staffId: string } }) {
  const guard = await requireAdminApi("admin.staff.recovery_session.create");
  if (!guard.ok) return guard.response;
  const reauthFailure = requireStaffSensitiveReauth(guard.session);
  if (reauthFailure) return reauthFailure;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.reason !== "string") {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = issueNormalRecoverySession(
      { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys },
      { targetStaffId: params.staffId, reason: body.reason },
    );
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformGovernanceError) {
      return NextResponse.json({ error: error.code }, { status: platformGovernanceErrorStatus(error.code) });
    }
    return staffFailure(error);
  }
}
