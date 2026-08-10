import { NextResponse } from "next/server";
import { requireAdminApi, verifyReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { executeSubscriptionReassignment, type ReassignmentEffectiveMode } from "@/lib/billing/bi001-service";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";

export async function POST(request: Request, { params }: { params: { subscriptionId: string } }) {
  const guard = await requireAdminApi("subscription_reassignment_manage");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`billing-reassignment-execute:${guard.session.sub}`, 20, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  if (!(await verifyReauth(guard.session.email, currentPassword))) {
    return NextResponse.json({ error: "REAUTHENTICATION_REQUIRED" }, { status: 401 });
  }
  if (typeof body.caseId !== "string" || typeof body.targetLearnerId !== "string" ||
    !["immediate_if_unused", "next_period"].includes(String(body.effectiveMode)) ||
    typeof body.reasonCode !== "string" || typeof body.expectedSubscriptionVersion !== "number" ||
    typeof body.expectedCaseVersion !== "number" || typeof body.idempotencyKey !== "string") {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = executeSubscriptionReassignment(guard.session.sub, params.subscriptionId, {
      caseId: body.caseId,
      targetLearnerId: body.targetLearnerId,
      effectiveMode: body.effectiveMode as ReassignmentEffectiveMode,
      reasonCode: body.reasonCode,
      expectedSubscriptionVersion: body.expectedSubscriptionVersion,
      expectedCaseVersion: body.expectedCaseVersion,
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof BillingAssignmentError) {
      return NextResponse.json({ error: error.code }, { status: billingAssignmentErrorStatus(error.code),
        headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
