import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { getOperationChange, listOperationActivity, updateOperationChangeWorkflow } from "@/lib/operations-admin/service";
import { OperationChangeError, operationChangeErrorStatus, OPERATION_CHANGE_STATUSES } from "@/lib/operations-admin/contracts";

// API-AD-024: operation detail + append-only activity. Safe AR/UL/AU
// source snapshot composition is left to each domain's own existing admin
// read endpoints (rule 89-90 — no duplicate source-state table here).
export async function GET(_request: Request, { params }: { params: { operationChangeId: string } }) {
  const guard = await requireAdminApi("admin.operations.change.read");
  if (!guard.ok) return guard.response;
  try {
    const change = getOperationChange(params.operationChangeId);
    const activity = listOperationActivity(params.operationChangeId);
    return NextResponse.json({ ...change, activity }, { headers: { "Cache-Control": "private, no-store", ETag: `"${change.version}"` } });
  } catch (error) {
    if (error instanceof OperationChangeError) {
      return NextResponse.json({ error: error.code }, { status: operationChangeErrorStatus(error.code) });
    }
    throw error;
  }
}

// API-AD-025: workflow-only fields — status/assignment/scheduledFor. Never
// type/environment/resource/reason (rule 9, 25).
export async function PATCH(request: Request, { params }: { params: { operationChangeId: string } }) {
  const guard = await requireAdminApi("admin.operations.change.workflow_update");
  if (!guard.ok) return guard.response;
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (!Number.isInteger(body.expectedVersion) || typeof body.idempotencyKey !== "string" || !body.idempotencyKey) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (body.status !== undefined && !(OPERATION_CHANGE_STATUSES as readonly string[]).includes(body.status as string)) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  try {
    const result = updateOperationChangeWorkflow(
      { staffAccountId: guard.session.staffAccountId, roleKeys: guard.session.roleKeys }, params.operationChangeId,
      {
        expectedVersion: body.expectedVersion as number, idempotencyKey: body.idempotencyKey,
        status: body.status as never, assignedStaffAccountId: body.assignedStaffAccountId as never,
        scheduledFor: body.scheduledFor as never,
      },
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof OperationChangeError) {
      return NextResponse.json({ error: error.code }, { status: operationChangeErrorStatus(error.code) });
    }
    throw error;
  }
}
