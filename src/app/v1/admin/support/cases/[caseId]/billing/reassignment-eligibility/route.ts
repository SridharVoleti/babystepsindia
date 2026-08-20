import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { getReassignmentEligibility } from "@/lib/support-cases/billing";
import { SupportCaseError, supportCaseErrorStatus } from "@/lib/support-cases/contracts";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";

// API-AD-018: advisory-only BI-001 eligible-target summary.
export async function GET(request: Request, { params }: { params: { caseId: string } }) {
  const guard = await requireAdminApi("admin.support.billing.reassignment_eligibility.read");
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);
  try {
    const result = await getReassignmentEligibility(
      { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys },
      params.caseId, url.searchParams.get("subscriptionId") ?? undefined,
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
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
