import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { withLockedEndUserMutation } from "@/lib/authorization/locked-mutation";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { createReassignmentCase } from "@/lib/billing/bi001-service";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const targetLearnerId = typeof body.targetLearnerId === "string" ? body.targetLearnerId : "";
  const guard = await requireEndUserAuthorization(request, "parent.billing.reassignment_case.create",
    { learnerId: targetLearnerId });
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`billing-reassignment-case:${guard.parent.session.sub}`, 10, 24 * 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  if (!targetLearnerId || typeof body.subscriptionId !== "string" || typeof body.reasonCode !== "string" ||
    typeof body.idempotencyKey !== "string") {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = await withLockedEndUserMutation({ preflight: guard.authorization,
      action: "parent.billing.reassignment_case.create", resource: { learnerId: targetLearnerId },
      mutate: () => createReassignmentCase(guard.parent.session.sub, {
        subscriptionId: body.subscriptionId as string,
        targetLearnerId,
        reasonCode: body.reasonCode as string,
        notes: typeof body.notes === "string" ? body.notes : undefined,
        idempotencyKey: body.idempotencyKey as string,
      }) });
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BillingAssignmentError) {
      return NextResponse.json({ error: error.code }, { status: billingAssignmentErrorStatus(error.code),
        headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
