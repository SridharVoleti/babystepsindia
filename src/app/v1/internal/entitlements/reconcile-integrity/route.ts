import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { runEntitlementIntegritySweep } from "@/lib/entitlement-integrity/sweep";
import { EntitlementIntegrityError, entitlementIntegrityErrorStatus } from "@/lib/entitlement-integrity/errors";

// EN-004 rules 5-7, 53: bounded, resumable, environment-isolated scheduled
// reconciliation across the entitlement domains. The spec's own API
// contract text lists sourceDomains/from/to/cursor/limit/runIdempotencyKey
// only, but rule 7's environment isolation is only enforceable with an
// explicit environment on the request — added here as a structurally
// necessary field beyond the literal contract text.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "entitlement-integrity-monitor");
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.environment !== "string" || typeof body.runIdempotencyKey !== "string" ||
    typeof body.limit !== "number" ||
    (body.sourceDomains !== undefined && (!Array.isArray(body.sourceDomains) || body.sourceDomains.some((d) => typeof d !== "string"))) ||
    (body.from !== undefined && typeof body.from !== "string") ||
    (body.to !== undefined && typeof body.to !== "string") ||
    (body.cursor !== undefined && typeof body.cursor !== "string")) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = runEntitlementIntegritySweep(guard.principal.id, {
      environment: body.environment, sourceDomains: body.sourceDomains as string[] | undefined,
      from: body.from as string | undefined, to: body.to as string | undefined,
      cursor: body.cursor as string | undefined, limit: body.limit, runIdempotencyKey: body.runIdempotencyKey,
    }, new Date());
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof EntitlementIntegrityError) {
      return NextResponse.json({ error: error.code },
        { status: entitlementIntegrityErrorStatus(error.code), headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
