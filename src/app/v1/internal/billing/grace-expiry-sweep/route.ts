import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { runGraceExpirySweep } from "@/lib/billing/bi003-service";
import { BillingAssignmentError, billingAssignmentErrorStatus } from "@/lib/billing/errors";

export async function POST(request: Request) {
  const guard = await requireInternalService(request, "billing-recovery");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.limit !== "number" || typeof body.runIdempotencyKey !== "string" ||
    (body.provider !== undefined && typeof body.provider !== "string") ||
    (body.cursor !== undefined && typeof body.cursor !== "string")) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = await runGraceExpirySweep(guard.principal.id, { provider: body.provider as string | undefined,
      cursor: body.cursor as string | undefined, limit: body.limit, runIdempotencyKey: body.runIdempotencyKey });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BillingAssignmentError) return NextResponse.json({ error: error.code },
      { status: billingAssignmentErrorStatus(error.code), headers: { "Cache-Control": "no-store" } });
    throw error;
  }
}
