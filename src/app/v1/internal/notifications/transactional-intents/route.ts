import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { enqueueTransactionalNotification, NotificationServiceError } from "@/lib/notifications/service";

// API-NT-001: allowlisted source-service principal enqueues one logical
// transactional notification. Thin wrapper over the same
// enqueueTransactionalNotification function BI-*/IA-003 call directly
// in-process inside their own commit transaction.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "notification-enqueue");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  // NT1-G01: frozen contract accepts recipientParentId (source-of-record
  // recipient identity — never an arbitrary caller-supplied email
  // destination; the actual send address is still resolved fresh from the
  // verified parent identity at delivery time) and a required idempotencyKey.
  if (typeof body.notificationType !== "string" || typeof body.sourceDomain !== "string" ||
    typeof body.sourceEventKey !== "string" || typeof body.sourceVersion !== "number" ||
    typeof body.recipientParentId !== "string" || typeof body.idempotencyKey !== "string" ||
    body.idempotencyKey.length === 0 || body.idempotencyKey.length > 200 ||
    typeof body.safeVariables !== "object" || body.safeVariables === null) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = await enqueueTransactionalNotification({
      notificationType: body.notificationType, sourceDomain: body.sourceDomain,
      sourceEventKey: body.sourceEventKey, sourceVersion: body.sourceVersion, parentId: body.recipientParentId,
      templateVersion: typeof body.templateVersion === "string" ? body.templateVersion : undefined,
      safeVariables: body.safeVariables as Record<string, unknown>,
      idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof NotificationServiceError) {
      const status = error.code === "RESOURCE_NOT_FOUND" ? 404
        : error.code === "NOTIFICATION_SEMANTIC_CONFLICT" ? 409 : 422;
      return NextResponse.json({ error: error.code }, { status });
    }
    throw error;
  }
}
