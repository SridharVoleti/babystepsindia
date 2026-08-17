import { NextResponse } from "next/server";
import { requireAdminApi, requireSuperAdminApi } from "@/lib/auth/admin-api-guard";
import { DisasterRecoveryError, listRecoveryTestRecords, startRecoveryTestRecord } from "@/lib/disaster-recovery/service";

// BR-002 closure criterion: "only Super Admin has default restore
// authority" — starting a recovery-drill evidence record requires the
// Super Admin gate (all 4 staff roles); reading the evidence log is
// available to any Platform Administrator.
export async function GET() {
  const guard = await requireAdminApi("admin.platform.recovery_test.read");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ records: listRecoveryTestRecords() }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const guard = await requireSuperAdminApi("admin.platform.recovery_test.start");
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (
    typeof body.backupReference !== "string" || typeof body.tempProjectReference !== "string" ||
    typeof body.idempotencyKey !== "string" || !body.idempotencyKey
  ) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = startRecoveryTestRecord(
      { staffAccountId: guard.session.staffAccountId },
      {
        backupReference: body.backupReference, tempProjectReference: body.tempProjectReference,
        outboundProcessingSuppressed: body.outboundProcessingSuppressed === true,
        idempotencyKey: body.idempotencyKey,
      },
    );
    return NextResponse.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DisasterRecoveryError) {
      return NextResponse.json({ error: error.code }, { status: 400 });
    }
    throw error;
  }
}
