import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { applyPaidCycle, EntitlementCycleError } from "@/lib/entitlement-cycle/service";

const STATUS_BY_CODE: Record<string, number> = {
  ENTITLEMENT_APP_CONFIGURATION_INVALID: 400,
  INVALID_ENTITLEMENT_CONTEXT: 400,
  ENTITLEMENT_SOURCE_MISMATCH: 404,
  IDEMPOTENCY_KEY_REUSED: 409,
  PAID_CYCLE_CONFLICT: 409,
};

// EN-001, trusted-platform-service-only. BI-002 uses the preferred in-process
// service call; this endpoint remains for other trusted platform producers.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "entitlement-applier");
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const required = ["paidCycleId", "eventId", "eventVersion", "subscriptionId", "purchaserParentId",
    "assignedLearnerId", "productId", "productVersion", "appIds", "periodStart", "periodEnd",
    "billingAnchor", "environment"];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null) {
      return NextResponse.json({ error: "INVALID_ENTITLEMENT_CONTEXT" }, { status: 400 });
    }
  }
  if (!Array.isArray(body.appIds) || body.appIds.some((id) => typeof id !== "string")) {
    return NextResponse.json({ error: "INVALID_ENTITLEMENT_CONTEXT" }, { status: 400 });
  }

  try {
    const result = await applyPaidCycle({
      paidCycleId: String(body.paidCycleId), eventId: String(body.eventId), eventVersion: Number(body.eventVersion),
      subscriptionId: String(body.subscriptionId), purchaserParentId: String(body.purchaserParentId),
      assignedLearnerId: String(body.assignedLearnerId), productId: String(body.productId),
      productVersion: Number(body.productVersion), appIds: body.appIds as string[],
      periodStart: String(body.periodStart), periodEnd: String(body.periodEnd),
      billingAnchor: String(body.billingAnchor), environment: String(body.environment), now: new Date(),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof EntitlementCycleError) {
      return NextResponse.json({ error: error.code }, { status: STATUS_BY_CODE[error.code] ?? 400 });
    }
    throw error;
  }
}
