import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { runUpcomingRenewalReminderSweep } from "@/lib/billing/bi002-service";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";

export async function POST(request: Request) {
  const guard = await requireInternalService(request, "billing-notification");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.startDueAt !== "string" || typeof body.endDueAt !== "string" ||
    typeof body.limit !== "number" || typeof body.runIdempotencyKey !== "string") {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = await runUpcomingRenewalReminderSweep(guard.principal.id, {
      startDueAt: body.startDueAt, endDueAt: body.endDueAt,
      cursor: typeof body.cursor === "string" ? body.cursor : undefined,
      limit: body.limit, runIdempotencyKey: body.runIdempotencyKey,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BillingAssignmentError) {
      return NextResponse.json({ error: error.code }, { status: billingAssignmentErrorStatus(error.code) });
    }
    throw error;
  }
}
