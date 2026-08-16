import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { createOperationChange, listOperationChanges } from "@/lib/operations-admin/service";
import { OperationChangeError, operationChangeErrorStatus, OPERATION_CHANGE_TYPES, OPERATION_CHANGE_STATUSES } from
  "@/lib/operations-admin/contracts";

// API-AD-022: create an immutable scoped operation/change record.
export async function POST(request: Request) {
  const guard = await requireAdminApi("admin.operations.change.create");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.changeType !== "string" || !(OPERATION_CHANGE_TYPES as readonly string[]).includes(body.changeType) ||
    typeof body.environment !== "string" || !body.environment.trim() ||
    typeof body.reason !== "string" || typeof body.idempotencyKey !== "string" || !body.idempotencyKey) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = createOperationChange(
      { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys },
      {
        changeType: body.changeType as never, environment: body.environment,
        appId: typeof body.appId === "string" ? body.appId : undefined,
        primaryResourceType: typeof body.primaryResourceType === "string" ? body.primaryResourceType : undefined,
        primaryResourceId: typeof body.primaryResourceId === "string" ? body.primaryResourceId : undefined,
        reason: body.reason, scheduledFor: typeof body.scheduledFor === "string" ? body.scheduledFor : undefined,
        linkedSupportCaseId: typeof body.linkedSupportCaseId === "string" ? body.linkedSupportCaseId : undefined,
        idempotencyKey: body.idempotencyKey,
      },
    );
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof OperationChangeError) {
      return NextResponse.json({ error: error.code }, { status: operationChangeErrorStatus(error.code) });
    }
    throw error;
  }
}

// API-AD-023: list permitted changes with safe filters/cursor.
export async function GET(request: Request) {
  const guard = await requireAdminApi("admin.operations.change.list");
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const changeType = url.searchParams.get("changeType") ?? undefined;
  if (status && !(OPERATION_CHANGE_STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (changeType && !(OPERATION_CHANGE_TYPES as readonly string[]).includes(changeType)) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const result = listOperationChanges(
    { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys },
    {
      status: status as never, changeType: changeType as never,
      appId: url.searchParams.get("appId") ?? undefined, environment: url.searchParams.get("environment") ?? undefined,
      assignedToMe: url.searchParams.get("assignedToMe") === "true",
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
    },
  );
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
