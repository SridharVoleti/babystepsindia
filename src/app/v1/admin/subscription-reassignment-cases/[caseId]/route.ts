import { NextResponse } from "next/server";
import { hasRecentAdminAuthentication, requireAdminApi } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { getAdminReassignmentCase } from "@/lib/billing/bi001-service";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";

export async function GET(_request: Request, { params }: { params: { caseId: string } }) {
  const guard = await requireAdminApi("subscription_reassignment_manage");
  if (!guard.ok) return guard.response;
  if (!hasRecentAdminAuthentication(guard.session)) {
    return NextResponse.json({ error: "REAUTHENTICATION_REQUIRED" }, { status: 401 });
  }
  if (!checkRateLimit(`billing-reassignment-case-read:${guard.session.sub}`, 60, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  try {
    return NextResponse.json(getAdminReassignmentCase(params.caseId),
      { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof BillingAssignmentError) {
      return NextResponse.json({ error: error.code }, { status: billingAssignmentErrorStatus(error.code) });
    }
    throw error;
  }
}
