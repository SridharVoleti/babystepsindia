import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { getSupportCase, reopenSupportCase } from "@/lib/support-cases/service";
import { SupportCaseError, supportCaseErrorStatus } from "@/lib/support-cases/contracts";

// API-AD-016: authorized reopen during the 24-month retention window —
// only a `resolved` case, with a reason, audited.
export async function POST(request: Request, { params }: { params: { caseId: string } }) {
  const guard = await requireAdminApi("admin.support.case.reopen");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.reason !== "string" || typeof body.idempotencyKey !== "string" || !body.idempotencyKey) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const actor = { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys };
  try {
    getSupportCase(actor, params.caseId);
    const result = reopenSupportCase(actor, params.caseId, { reason: body.reason, idempotencyKey: body.idempotencyKey });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SupportCaseError) {
      return NextResponse.json({ error: error.code }, { status: supportCaseErrorStatus(error.code) });
    }
    throw error;
  }
}
