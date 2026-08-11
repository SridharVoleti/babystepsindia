import { NextResponse } from "next/server";
import { requireAdminApi, verifyReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { EntitlementIntegrityError, entitlementIntegrityErrorStatus } from "@/lib/entitlement-integrity/errors";
import { applyIncidentAction, type IncidentAction } from "@/lib/entitlement-integrity/incidents";

const ALLOWED_ACTIONS: IncidentAction[] = ["retry", "resolve_false_positive", "open_refund_case"];

// EN-004 rule 46: exact permission + recent reauthentication, same shape as
// PR-004's progress-integrity-incidents action route (rate-limit then
// re-verify the admin's own password on every call, no cached reauth
// timestamp) — the spec explicitly requires expectedVersion + idempotency
// here, unlike EN-003's narrower revoke route.
export async function POST(request: Request, { params }: { params: { incidentId: string } }) {
  const guard = await requireAdminApi("entitlement_integrity_manage");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`entitlement-integrity-action:${guard.session.sub}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  if (!(await verifyReauth(guard.session.email, currentPassword))) {
    return NextResponse.json({ error: "REAUTHENTICATION_REQUIRED" }, { status: 401 });
  }

  if (!ALLOWED_ACTIONS.includes(body.action as IncidentAction)) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (typeof body.expectedVersion !== "number" || typeof body.idempotencyKey !== "string" || !body.idempotencyKey) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = applyIncidentAction({
      incidentId: params.incidentId,
      action: body.action as IncidentAction,
      actorAdminId: guard.session.sub,
      expectedVersion: body.expectedVersion,
      idempotencyKey: body.idempotencyKey,
      reasonCategory: typeof body.reasonCategory === "string" ? body.reasonCategory : undefined,
      refundCaseId: typeof body.refundCaseId === "string" ? body.refundCaseId : undefined,
      now: new Date(),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof EntitlementIntegrityError) {
      return NextResponse.json({ error: error.code }, { status: entitlementIntegrityErrorStatus(error.code) });
    }
    throw error;
  }
}
