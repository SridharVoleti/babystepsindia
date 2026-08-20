import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { createPaymentMethodUpdateSession } from "@/lib/billing/bi003-service";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";

export async function POST(request: Request, { params }: { params: { subscriptionId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.billing.payment_method.update");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.expectedVersion !== "number" || typeof body.idempotencyKey !== "string") {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = await createPaymentMethodUpdateSession(guard.parent.session.sub, params.subscriptionId,
      { expectedVersion: body.expectedVersion, idempotencyKey: body.idempotencyKey });
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof BillingAssignmentError) return NextResponse.json({ error: error.code },
      { status: billingAssignmentErrorStatus(error.code), headers: { "Cache-Control": "private, no-store" } });
    throw error;
  }
}
