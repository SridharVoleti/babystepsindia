import { NextResponse } from "next/server";
import { requireAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";
import { restoreAccountViaGovernance } from "@/lib/platform-governance/restoration";
import { PlatformGovernanceError, platformGovernanceErrorStatus } from "@/lib/platform-governance/contracts";

// AD-005 rules 71-78: this is the same single restoration authority as
// API-AD-031 (/v1/admin/platform/parent-restorations) — restoreAccountViaGovernance
// is the one function either URL calls, so there is no alternate/weaker
// restoration path. Kept as its own URL only because this is where the
// pre-existing /admin/restore page already points.
export async function POST(request: Request, { params }: { params: { parentId: string } }) {
  const guard = await requireAdminApi("admin.account.restore");
  if (!guard.ok) return guard.response;
  const reauthFailure = await requireStaffSensitiveReauth(guard.session);
  if (reauthFailure) return reauthFailure;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (
    typeof body.reason !== "string" || typeof body.expectedVersion !== "number" ||
    typeof body.idempotencyKey !== "string" || !body.idempotencyKey
  ) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = await restoreAccountViaGovernance(
      { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys },
      {
        parentId: params.parentId, reason: body.reason, expectedVersion: body.expectedVersion,
        idempotencyKey: body.idempotencyKey,
        caseId: typeof body.caseId === "string" ? body.caseId : undefined,
        governanceReference: typeof body.governanceReference === "string" ? body.governanceReference : undefined,
      },
    );
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof PlatformGovernanceError) {
      return NextResponse.json({ error: error.code }, { status: platformGovernanceErrorStatus(error.code) });
    }
    throw error;
  }
}
