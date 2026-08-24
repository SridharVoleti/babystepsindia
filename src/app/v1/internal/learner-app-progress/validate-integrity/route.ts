import { NextResponse } from "next/server";
import { getDb } from "@/lib/db/client";
import { authorizeProtectedAppApi } from "@/lib/app-authorization/guard";
import { AppAuthorizationError } from "@/lib/app-authorization/service";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { ProgressIntegrityError, progressIntegrityErrorStatus } from "@/lib/progress-integrity/errors";
import { validateProgressIntegrity, type IntegrityReason } from "@/lib/progress-integrity/service";

const REASONS: IntegrityReason[] = ["read", "write", "launch", "reconcile"];

// PR-004 API contract: "exact LA-002 progress read/write domain OR AU-004
// reconciliation principal." The two callers are authenticated completely
// differently (app-service dual credential vs internal service assertion),
// so reason drives which branch runs — reason:"reconcile" is the only one
// that authenticates as a platform service and targets an explicit
// learner/app/environment supplied in the body (it has no session/grant
// context of its own to derive them from); every other reason authorizes
// via the app's grant token and derives learner/app/environment from it,
// exactly like every other app-facing progress route.
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  if (!REASONS.includes(body.reason as IntegrityReason)) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const reason = body.reason as IntegrityReason;
  const expectedIntegrityVersion = typeof body.expectedIntegrityVersion === "number" ? body.expectedIntegrityVersion : undefined;
  const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined;

  try {
    let learnerId: string; let appId: string; let environment: string; let requesterPrincipalId: string;

    if (reason === "reconcile") {
      const guard = await requireInternalService(request, "progress-integrity");
      if (!guard.ok) return guard.response;
      if (typeof body.learnerId !== "string" || typeof body.appId !== "string" || typeof body.environment !== "string") {
        return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
      }
      learnerId = body.learnerId; appId = body.appId; environment = body.environment;
      requesterPrincipalId = guard.principal.id;
    } else {
      const auth = await authorizeProtectedAppApi(request, "progress.integrity_validate");
      const session = getDb().prepare(`select deployment_environment from learner_sessions where id=?`)
        .get(auth.learnerSessionId) as { deployment_environment: string | null } | undefined;
      learnerId = auth.learnerId; appId = auth.appId; environment = session?.deployment_environment ?? "production";
      requesterPrincipalId = auth.principalId;
    }

    const result = await validateProgressIntegrity({ learnerId, appId, environment, reason, expectedIntegrityVersion,
      idempotencyKey, requesterPrincipalId, now: new Date() });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ProgressIntegrityError) {
      return NextResponse.json({ error: error.code }, { status: progressIntegrityErrorStatus(error.code) });
    }
    if (error instanceof AppAuthorizationError) {
      return NextResponse.json({ error: error.code }, { status: 401 });
    }
    throw error;
  }
}

