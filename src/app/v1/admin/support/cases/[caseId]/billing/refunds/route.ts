import { NextResponse } from "next/server";
import { hasRecentAdminAuthentication, requireAdminApi } from "@/lib/auth/admin-api-guard";
import { refundViaCase } from "@/lib/support-cases/billing";
import { SupportCaseError, supportCaseErrorStatus } from "@/lib/support-cases/contracts";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";

// API-AD-021: high-risk mutation — requires <=10m two-factor reauth (rule
// 48, 82), delegates entirely to BI-005 under lock; never marks a refund
// successful itself (rules 52-54).
export async function POST(request: Request, { params }: { params: { caseId: string } }) {
  const guard = await requireAdminApi("admin.support.billing.refund");
  if (!guard.ok) return guard.response;
  if (!(await hasRecentAdminAuthentication(guard.session))) {
    return NextResponse.json({ error: "REAUTHENTICATION_REQUIRED" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.subscriptionId !== "string" || (body.refundType !== "full" && body.refundType !== "partial") ||
    typeof body.reasonCode !== "string" || !body.reasonCode.trim() ||
    typeof body.idempotencyKey !== "string" || !body.idempotencyKey) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = await refundViaCase(
      { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys }, params.caseId,
      {
        subscriptionId: body.subscriptionId, refundType: body.refundType,
        amount: typeof body.amount === "number" ? body.amount : undefined, reasonCode: body.reasonCode,
        entitlementEffect: body.entitlementEffect as never, idempotencyKey: body.idempotencyKey,
      },
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SupportCaseError) {
      return NextResponse.json({ error: error.code }, { status: supportCaseErrorStatus(error.code) });
    }
    if (error instanceof BillingAssignmentError) {
      return NextResponse.json({ error: error.code }, { status: billingAssignmentErrorStatus(error.code) });
    }
    throw error;
  }
}
