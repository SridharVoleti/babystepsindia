import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { applyLifecycleEvent } from "@/lib/entitlement-lifecycle/service";
import { EntitlementLifecycleError, entitlementLifecycleErrorStatus } from "@/lib/entitlement-lifecycle/errors";
import type { LifecycleEventSource, LifecycleEventType } from "@/lib/entitlement-lifecycle/contracts";

const VALID_SOURCES = ["billing_cancellation", "billing_grace", "billing_refund", "billing_chargeback",
  "billing_dispute", "billing_reassignment", "platform_security", "reconciliation"];
const VALID_EVENT_TYPES = ["cancellation_effective", "cancellation_reversed", "grace_started", "grace_expired",
  "grace_recovered", "refund_confirmed", "refund_partial_no_change", "chargeback_confirmed", "chargeback_reversed",
  "dispute_opened", "reassignment_effective", "security_revoked"];

// EN-003 API/Service Contract: exact billing/identity/app/security source
// principal. Loads authoritative event details server-side and applies
// idempotently — see applyLifecycleEvent for the actual domain logic.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "entitlement-lifecycle");
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const required = ["eventId", "eventType", "source", "sourceVersion", "effectiveAt", "sourceReference"];
  for (const field of required) {
    if (body[field] === undefined || body[field] === null) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
  }
  if (!VALID_SOURCES.includes(String(body.source)) || !VALID_EVENT_TYPES.includes(String(body.eventType)) ||
    typeof body.sourceVersion !== "number" || typeof body.effectiveAt !== "string" ||
    typeof body.sourceReference !== "object" || body.sourceReference === null) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const ref = body.sourceReference as Record<string, unknown>;
  if (typeof ref.learnerId !== "string" || typeof ref.reasonCategory !== "string") {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = applyLifecycleEvent({
      eventId: String(body.eventId), eventType: body.eventType as LifecycleEventType,
      source: body.source as LifecycleEventSource, sourceVersion: body.sourceVersion,
      effectiveAt: body.effectiveAt,
      sourceReference: {
        subscriptionId: typeof ref.subscriptionId === "string" ? ref.subscriptionId : undefined,
        refundCaseId: typeof ref.refundCaseId === "string" ? ref.refundCaseId : undefined,
        disputeId: typeof ref.disputeId === "string" ? ref.disputeId : undefined,
        reassignmentCaseId: typeof ref.reassignmentCaseId === "string" ? ref.reassignmentCaseId : undefined,
        learnerId: ref.learnerId, appId: typeof ref.appId === "string" ? ref.appId : undefined,
        reasonCategory: ref.reasonCategory,
        policyEffect: ref.policyEffect === "terminate_now" || ref.policyEffect === "no_change" ? ref.policyEffect : undefined,
        fraudOrSecurityRisk: ref.fraudOrSecurityRisk === true,
      },
      now: new Date(),
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
