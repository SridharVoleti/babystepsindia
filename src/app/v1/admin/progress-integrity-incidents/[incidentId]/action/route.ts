import { NextResponse } from "next/server";
import { requireAdminApi, verifyReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { ProgressIntegrityError, progressIntegrityErrorStatus } from "@/lib/progress-integrity/errors";
import { applyIncidentAction, type IncidentAction } from "@/lib/progress-integrity/incidents";

const ALLOWED_ACTIONS: IncidentAction[] = ["revalidate", "retry_safe_metadata_repair", "link_matching_receipt",
  "resolve_legacy_policy", "open_disaster_recovery_case", "resolve_false_positive"];

// PR-004 rule 62: exact permission + recent reauthentication, same shape
// as the deployment-rollback admin route (rate-limit then re-verify the
// admin's own password on every call, no cached reauth timestamp).
export async function POST(request: Request, { params }: { params: { incidentId: string } }) {
  const guard = await requireAdminApi("progress_integrity_manage");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`progress-integrity-action:${guard.session.sub}`, 20, 5 * 60 * 1000)) {
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
      receiptId: typeof body.receiptId === "string" ? body.receiptId : undefined,
      now: new Date(),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ProgressIntegrityError) {
      return NextResponse.json({ error: error.code }, { status: progressIntegrityErrorStatus(error.code) });
    }
    throw error;
  }
}
