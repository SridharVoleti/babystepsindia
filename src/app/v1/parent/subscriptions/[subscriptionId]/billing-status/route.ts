import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { getSubscriptionBillingStatus } from "@/lib/billing/bi002-service";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";

export async function GET(request: Request, { params }: { params: { subscriptionId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.billing.status.read");
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json(await getSubscriptionBillingStatus(guard.parent.session.sub, params.subscriptionId),
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof BillingAssignmentError) {
      return NextResponse.json({ error: error.code }, { status: billingAssignmentErrorStatus(error.code),
        headers: { "Cache-Control": "private, no-store" } });
    }
    throw error;
  }
}
