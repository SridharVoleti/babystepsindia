import { NextResponse } from "next/server";
import { requireAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";
import { confirmProviderRefund } from "@/lib/billing/bi005-service";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";

// Billing Administrator + recent reauth. Wraps BI-005's own
// confirmProviderRefund — provider-confirmed outcome remains BI-005's
// authority, this route only gates who may call it.
export async function POST(request: Request, { params }: { params: { caseId: string } }) {
  const guard = await requireAdminApi("admin.billing.refund.confirm");
  if (!guard.ok) return guard.response;
  const reauthFailure = await requireStaffSensitiveReauth(guard.session);
  if (reauthFailure) return reauthFailure;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.expectedVersion !== "number" || typeof body.idempotencyKey !== "string" || !body.idempotencyKey) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = await confirmProviderRefund(guard.session.staffAccountId, params.caseId, {
      expectedVersion: body.expectedVersion,
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BillingAssignmentError) {
      return NextResponse.json({ error: error.code }, { status: billingAssignmentErrorStatus(error.code), headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
