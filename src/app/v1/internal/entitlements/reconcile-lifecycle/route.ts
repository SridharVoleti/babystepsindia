import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { reconcileEntitlementLifecycle } from "@/lib/entitlement-lifecycle/service";
import { EntitlementLifecycleError, entitlementLifecycleErrorStatus } from "@/lib/entitlement-lifecycle/errors";

// EN-003 rules 47-48: rebuilds lifecycle state from immutable billing/
// account/app/security sources. This is the only path that may emit
// chargeback_reversed — the financial-events webhook records the reversal
// but never applies it directly.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "entitlement-reconciliation");
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.runIdempotencyKey !== "string" ||
    (body.subscriptionId !== undefined && typeof body.subscriptionId !== "string") ||
    (body.learnerId !== undefined && typeof body.learnerId !== "string") ||
    (body.appId !== undefined && typeof body.appId !== "string") ||
    (body.sourceVersion !== undefined && typeof body.sourceVersion !== "number")) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = reconcileEntitlementLifecycle(guard.principal.id, {
      subscriptionId: body.subscriptionId as string | undefined,
      learnerId: body.learnerId as string | undefined,
      appId: body.appId as string | undefined,
      sourceVersion: body.sourceVersion as number | undefined,
      runIdempotencyKey: body.runIdempotencyKey,
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
