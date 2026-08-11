import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { reconcileLearnerApp } from "@/lib/entitlement-integrity/repair";
import { EntitlementIntegrityError, entitlementIntegrityErrorStatus } from "@/lib/entitlement-integrity/errors";

// EN-004 rules 25-27, 54: rebuilds effective/lifecycle/allocation
// consistency for one learner+app without inventing a source.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "entitlement-integrity-monitor");
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.learnerId !== "string" || typeof body.appId !== "string" ||
    typeof body.environment !== "string" || typeof body.expectedSourceVersion !== "number" ||
    typeof body.runIdempotencyKey !== "string") {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = reconcileLearnerApp({
      learnerId: body.learnerId, appId: body.appId, environment: body.environment,
      expectedSourceVersion: body.expectedSourceVersion, principalId: guard.principal.id,
      runIdempotencyKey: body.runIdempotencyKey, now: new Date(),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof EntitlementIntegrityError) {
      return NextResponse.json({ error: error.code },
        { status: entitlementIntegrityErrorStatus(error.code), headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
