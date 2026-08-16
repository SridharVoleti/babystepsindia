import { NextResponse } from "next/server";
import { requireAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";
import { restoreAccountViaGovernance } from "@/lib/platform-governance/restoration";
import { PlatformGovernanceError, platformGovernanceErrorStatus } from "@/lib/platform-governance/contracts";

// API-AD-031: Platform Administrator + <=10m two-factor reauth + exact
// case/governance reference delegates to IA-003's own restoreAccount —
// this route never edits email/password/phone/learner/subscription/
// progress/credit state itself (rules 76-78).
export async function POST(request: Request) {
  const guard = await requireAdminApi("admin.account.restore");
  if (!guard.ok) return guard.response;
  const reauthFailure = requireStaffSensitiveReauth(guard.session);
  if (reauthFailure) return reauthFailure;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (
    typeof body.parentId !== "string" || typeof body.reason !== "string" ||
    typeof body.expectedVersion !== "number" ||
    typeof body.idempotencyKey !== "string" || !body.idempotencyKey
  ) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = restoreAccountViaGovernance(
      { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys },
      {
        parentId: body.parentId, reason: body.reason, expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        caseId: typeof body.caseId === "string" ? body.caseId : undefined,
        governanceReference: typeof body.governanceReference === "string" ? body.governanceReference : undefined,
      },
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformGovernanceError) {
      return NextResponse.json({ error: error.code }, { status: platformGovernanceErrorStatus(error.code) });
    }
    throw error;
  }
}
