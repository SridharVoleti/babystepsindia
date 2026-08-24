import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { ProgressRecoveryError, progressRecoveryErrorStatus, reconcileRecoveryReceipt } from "@/lib/progress-recovery/service";

// AU-004's progress-recovery principal only. Deliberately accepts no
// pendingState/payload field at all — it can only confirm or flag what a
// receipt already claims happened, never invent or accept a new target.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "progress-recovery");
  if (!guard.ok) return guard.response;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.receiptId !== "string" || !body.receiptId) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = await reconcileRecoveryReceipt(body.receiptId, new Date());
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ProgressRecoveryError) {
      return NextResponse.json({ error: error.code }, { status: progressRecoveryErrorStatus(error.code) });
    }
    throw error;
  }
}

