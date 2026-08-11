import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { sweepDueLifecycleTransitions } from "@/lib/entitlement-lifecycle/service";
import { EntitlementLifecycleError, entitlementLifecycleErrorStatus } from "@/lib/entitlement-lifecycle/errors";

// EN-003 rule 64: bounded sweep processing due cancellation/grace/period
// boundaries and any 'pending' event stuck by a prior effect failure
// (rule 67), using the exact same transition function as apply-lifecycle-event.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "entitlement-lifecycle");
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.dueBefore !== "string" || typeof body.limit !== "number" ||
    typeof body.runIdempotencyKey !== "string" ||
    (body.transitionType !== undefined && typeof body.transitionType !== "string") ||
    (body.cursor !== undefined && typeof body.cursor !== "string")) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = sweepDueLifecycleTransitions(guard.principal.id, {
      transitionType: body.transitionType as string | undefined,
      dueBefore: body.dueBefore, cursor: body.cursor as string | undefined,
      limit: body.limit, runIdempotencyKey: body.runIdempotencyKey,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof EntitlementLifecycleError) {
      return NextResponse.json({ error: error.code },
        { status: entitlementLifecycleErrorStatus(error.code), headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
