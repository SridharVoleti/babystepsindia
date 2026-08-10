import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { cancelSubscriptionAtPeriodEnd } from "@/lib/billing/bi004-service";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";

export async function POST(request: Request, { params }: { params: { subscriptionId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.billing.subscription.cancel");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`subscription-cancel:${guard.parent.session.sub}:${params.subscriptionId}`,
    20, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.expectedVersion !== "number" || typeof body.idempotencyKey !== "string") {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = withLockedEndUserMutation({ preflight: guard.authorization,
      action: "parent.billing.subscription.cancel", mutate: () => cancelSubscriptionAtPeriodEnd(
        guard.parent.session.sub, params.subscriptionId, {
          expectedVersion: body.expectedVersion as number, idempotencyKey: body.idempotencyKey as string,
        }) });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof BillingAssignmentError) {
      return NextResponse.json({ error: error.code }, { status: billingAssignmentErrorStatus(error.code),
        headers: { "Cache-Control": "private, no-store" } });
    }
    throw error;
  }
}
