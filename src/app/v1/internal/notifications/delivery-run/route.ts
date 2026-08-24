import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import {
  DeliveryRunConflictError, InvalidDeliveryRunCursorError, NotificationServiceError, runDeliveryRunApiV1,
} from "@/lib/notifications/service";

// API-NT-002 (NT1-G03): bounded-batch delivery worker with the frozen
// cursor/runIdempotencyKey contract. No dependency on browser
// sessions/heartbeats (rule 111) — a scheduler principal calls this on a
// recurring interval.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "notification-delivery");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.runIdempotencyKey !== "string" || body.runIdempotencyKey.length === 0 ||
    (body.cursor !== undefined && body.cursor !== null && typeof body.cursor !== "string") ||
    (body.limit !== undefined && typeof body.limit !== "number")) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = await runDeliveryRunApiV1({
      cursor: typeof body.cursor === "string" ? body.cursor : null,
      limit: typeof body.limit === "number" ? body.limit : 20,
      runIdempotencyKey: body.runIdempotencyKey,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InvalidDeliveryRunCursorError) {
      return NextResponse.json({ error: "INVALID_CURSOR" }, { status: 400 });
    }
    if (error instanceof DeliveryRunConflictError) {
      return NextResponse.json({ error: "DELIVERY_RUN_CONFLICT" }, { status: 409 });
    }
    if (error instanceof NotificationServiceError) {
      return NextResponse.json({ error: error.code }, { status: 400 });
    }
    return NextResponse.json({ error: "DELIVERY_RUN_FAILED" }, { status: 500 });
  }
}
