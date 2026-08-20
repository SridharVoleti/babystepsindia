import { NextResponse } from "next/server";
import { requireAdminApi, requireSuperAdminApi } from "@/lib/auth/admin-api-guard";
import { DisasterRecoveryError, getRecoveryTestRecord, updateRecoveryTestRecord } from "@/lib/disaster-recovery/service";

type StepBody = { confirmed: boolean; notes?: string };

function isStepBody(value: unknown): value is StepBody {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.confirmed !== "boolean") return false;
  if (record.notes !== undefined && typeof record.notes !== "string") return false;
  return true;
}

export async function GET(request: Request, { params }: { params: { recordId: string } }) {
  const guard = await requireAdminApi("admin.platform.recovery_test.read");
  if (!guard.ok) return guard.response;
  const record = getRecoveryTestRecord(params.recordId);
  if (!record) return NextResponse.json({ error: "RECORD_NOT_FOUND" }, { status: 404 });
  return NextResponse.json(record, { headers: { "Cache-Control": "private, no-store" } });
}

// Same Super Admin gate as start — recording a step outcome or teardown
// confirmation is still an authority over the evidence record.
export async function PATCH(request: Request, { params }: { params: { recordId: string } }) {
  const guard = await requireSuperAdminApi("admin.platform.recovery_test.update");
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  for (const field of ["deletionReplay", "billingReconciliation", "derivableStateRebuild", "criticalFlows"]) {
    if (body[field] !== undefined && !isStepBody(body[field])) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
  }
  if (body.teardownConfirmed !== undefined && typeof body.teardownConfirmed !== "boolean") {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = await updateRecoveryTestRecord(
      { staffAccountId: guard.session.staffAccountId },
      {
        recordId: params.recordId,
        deletionReplay: body.deletionReplay as StepBody | undefined,
        billingReconciliation: body.billingReconciliation as StepBody | undefined,
        derivableStateRebuild: body.derivableStateRebuild as StepBody | undefined,
        criticalFlows: body.criticalFlows as StepBody | undefined,
        teardownConfirmed: body.teardownConfirmed as boolean | undefined,
        idempotencyKey: body.idempotencyKey,
      },
    );
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DisasterRecoveryError) {
      const status = error.code === "RECORD_NOT_FOUND" ? 404 : 400;
      return NextResponse.json({ error: error.code }, { status });
    }
    throw error;
  }
}
