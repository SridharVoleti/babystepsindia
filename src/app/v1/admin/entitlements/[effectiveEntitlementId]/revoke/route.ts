import { NextResponse } from "next/server";
import { requireAdminApi, requireReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { getDb } from "@/lib/db/client";
import { applyLifecycleEvent } from "@/lib/entitlement-lifecycle/service";
import { EntitlementLifecycleError, entitlementLifecycleErrorStatus } from "@/lib/entitlement-lifecycle/errors";

// EN-003 rules 56-57: the only admin-facing lever that can immediately
// suspend a specific learner-app's access outside the normal billing
// lifecycle. Routes through applyLifecycleEvent like every other producer —
// there is no direct UPDATE of entitlement state from this or any admin
// route.
export async function POST(request: Request, { params }: { params: { effectiveEntitlementId: string } }) {
  const guard = await requireAdminApi("admin.entitlements.security_revoke");
  if (!guard.ok) return guard.response;
  if (!checkRateLimit(`entitlement-security-revoke:${guard.session.sub}`, 20, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  const reauthFailure = await requireReauth(guard.session);

  if (reauthFailure) return reauthFailure;
  if (typeof body.reasonCategory !== "string" || typeof body.eventId !== "string") {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  const row = getDb().prepare(
    "select learner_id,app_id,lifecycle_version from learner_app_effective_entitlements where id=?",
  ).get(params.effectiveEntitlementId) as { learner_id: string; app_id: string; lifecycle_version: number } | undefined;
  if (!row) return NextResponse.json({ error: "RESOURCE_NOT_FOUND" }, { status: 404 });

  try {
    const result = applyLifecycleEvent({
      eventId: body.eventId, eventType: "security_revoked", source: "platform_security",
      sourceVersion: row.lifecycle_version + 1, effectiveAt: new Date().toISOString(),
      sourceReference: { learnerId: row.learner_id, appId: row.app_id, reasonCategory: body.reasonCategory,
        fraudOrSecurityRisk: body.fraudOrSecurityRisk === true },
      now: new Date(),
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof EntitlementLifecycleError) {
      return NextResponse.json({ error: error.code },
        { status: entitlementLifecycleErrorStatus(error.code), headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
