import { NextResponse } from "next/server";
import { requireAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";
import { createRefundCase } from "@/lib/billing/bi005-service";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";

// Billing Administrator + recent reauth. Wraps BI-005's own
// createRefundCase — this route only gates who may call it; BI-005
// remains the sole authority for refund business validation/state.
export async function POST(request: Request) {
  const guard = await requireAdminApi("admin.billing.refund.create");
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
    typeof body.subscriptionId !== "string" ||
    (body.refundType !== "full" && body.refundType !== "partial") ||
    typeof body.reasonCategory !== "string"
  ) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = await createRefundCase(guard.session.staffAccountId, {
      subscriptionId: body.subscriptionId,
      refundType: body.refundType,
      amount: typeof body.amount === "number" ? body.amount : undefined,
      reasonCategory: body.reasonCategory,
      entitlementEffect:
        body.entitlementEffect === "terminate_now" || body.entitlementEffect === "no_change"
          ? body.entitlementEffect
          : undefined,
    });
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BillingAssignmentError) {
      return NextResponse.json({ error: error.code }, { status: billingAssignmentErrorStatus(error.code), headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
