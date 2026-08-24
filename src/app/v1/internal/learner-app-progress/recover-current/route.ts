import { NextResponse } from "next/server";
import { authorizeProtectedAppApi } from "@/lib/app-authorization/guard";
import { AppAuthorizationError } from "@/lib/app-authorization/service";
import { AppProgressError } from "@/lib/app-progress/service";
import { ProgressRecoveryError, progressRecoveryErrorStatus, recoverCurrentProgress } from "@/lib/progress-recovery/service";

const REQUIRED_FIELDS = ["deviceSessionId", "credential", "expectedProgressVersion", "baseStateHash",
  "recoverySequence", "stateSchemaVersion", "pendingState", "recoveryCapsuleId", "idempotencyKey"];

// PR-002 rule 29: recovery submits through the same LA-003 checkpoint
// validation/write domain as an ordinary meaningful checkpoint — this
// route is the recovery-specific entry point, requiring LA-002 dual proof
// and the exact progress.recover scope for the resumed session/device.
export async function POST(request: Request) {
  try {
    const auth = await authorizeProtectedAppApi(request, "progress.recover");
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || REQUIRED_FIELDS.some((key) => !(key in body))) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    if (typeof body.deviceSessionId !== "string" || typeof body.credential !== "string" ||
      typeof body.expectedProgressVersion !== "number" || typeof body.baseStateHash !== "string" ||
      typeof body.recoverySequence !== "number" || typeof body.stateSchemaVersion !== "number" ||
      typeof body.recoveryCapsuleId !== "string" || typeof body.idempotencyKey !== "string") {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    const result = await recoverCurrentProgress(auth, {
      deviceSessionId: body.deviceSessionId, credential: body.credential,
      expectedProgressVersion: body.expectedProgressVersion, baseStateHash: body.baseStateHash,
      recoverySequence: body.recoverySequence, stateSchemaVersion: body.stateSchemaVersion,
      pendingState: body.pendingState, recoveryCapsuleId: body.recoveryCapsuleId,
      idempotencyKey: body.idempotencyKey,
      expectedIntegrityVersion: typeof body.expectedIntegrityVersion === "number" ? body.expectedIntegrityVersion : undefined,
    }, new Date());
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ProgressRecoveryError) {
      return NextResponse.json({ error: error.code }, { status: progressRecoveryErrorStatus(error.code) });
    }
    if (error instanceof AppProgressError) {
      return NextResponse.json({ error: error.code }, { status: 400 });
    }
    if (error instanceof AppAuthorizationError) {
      return NextResponse.json({ error: error.code }, { status: 401 });
    }
    throw error;
  }
}

