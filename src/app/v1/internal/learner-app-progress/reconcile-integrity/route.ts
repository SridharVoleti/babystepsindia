import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { runReconciliationSweep } from "@/lib/progress-integrity/reconcile";

// PR-004 rules 56, 58: the scheduler-invoked bulk sweep, distinct from the
// reason:"reconcile" branch of validate-integrity (a one-off targeted
// recheck). Guarded solely by the progress-integrity service role — no
// admin-facing counterpart exists for this route.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "progress-integrity");
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  if (typeof body.environment !== "string" || !body.environment) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (typeof body.runIdempotencyKey !== "string" || !body.runIdempotencyKey) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : 100;

  const result = runReconciliationSweep({
    appId: typeof body.appId === "string" ? body.appId : undefined,
    environment: body.environment,
    cursor: typeof body.cursor === "string" ? body.cursor : undefined,
    limit,
    runIdempotencyKey: body.runIdempotencyKey,
    now: new Date(),
  });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
