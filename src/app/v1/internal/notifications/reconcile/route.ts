import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import {
  InvalidDeliveryRunCursorError, NotificationNotFoundError, NotificationServiceError,
  ReconcileRunConflictError, runReconcileApiV1,
} from "@/lib/notifications/service";

// API-NT-004 (NT1-G04): resolves deliveries stuck "sending" (uncertain
// provider acceptance) before any further send is attempted (rule 68), via
// the frozen cursor/runIdempotencyKey/notificationId contract.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "notification-reconcile");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.runIdempotencyKey !== "string" || body.runIdempotencyKey.length === 0 ||
    (body.notificationId !== undefined && typeof body.notificationId !== "string") ||
    (body.cursor !== undefined && body.cursor !== null && typeof body.cursor !== "string") ||
    (body.limit !== undefined && typeof body.limit !== "number")) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = runReconcileApiV1({
      notificationId: typeof body.notificationId === "string" ? body.notificationId : undefined,
      cursor: typeof body.cursor === "string" ? body.cursor : null,
      limit: typeof body.limit === "number" ? body.limit : 20,
      runIdempotencyKey: body.runIdempotencyKey,
      staleAfterMinutes: typeof body.staleAfterMinutes === "number" ? body.staleAfterMinutes : undefined,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InvalidDeliveryRunCursorError) {
      return NextResponse.json({ error: "INVALID_CURSOR" }, { status: 400 });
    }
    if (error instanceof ReconcileRunConflictError) {
      return NextResponse.json({ error: "RECONCILE_RUN_CONFLICT" }, { status: 409 });
    }
    if (error instanceof NotificationNotFoundError) {
      return NextResponse.json({ error: "RESOURCE_NOT_FOUND" }, { status: 404 });
    }
    if (error instanceof NotificationServiceError) {
      return NextResponse.json({ error: error.code }, { status: 400 });
    }
    return NextResponse.json({ error: "RECONCILE_RUN_FAILED" }, { status: 500 });
  }
}
