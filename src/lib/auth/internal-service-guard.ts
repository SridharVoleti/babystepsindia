import { NextResponse } from "next/server";
import { authenticatePlatformServiceAssertion, InternalAuthorizationDecisionError } from "@/lib/authorization/internal-decision";
import { createManagedServicePrincipal, type ManagedServicePrincipal } from "@/lib/authorization/principals";
import { getDb } from "@/lib/db/client";

export type PlatformServiceRole =
  | "scheduler"
  | "contributor"
  | "entitlement-applier"
  | "entitlement-evaluator"
  | "ci-deployer"
  | "deployment-scheduler"
  | "progress-integrity"
  | "billing-reconciliation"
  | "billing-notification"
  | "billing-recovery"
  | "progress-recovery"
  | "entitlement-lifecycle"
  | "entitlement-reconciliation";
const CONTRACTS: Record<PlatformServiceRole, { serviceKey: string; audience: string }> = {
  scheduler: { serviceKey: "analytics-scheduler", audience: "babysteps:internal:analytics:run" },
  contributor: { serviceKey: "analytics-contributor", audience: "babysteps:internal:analytics:contribute" },
  "entitlement-applier": { serviceKey: "entitlement-cycle-applier", audience: "babysteps:internal:entitlements:apply_cycle" },
  "entitlement-evaluator": { serviceKey: "entitlement-access-evaluator", audience: "babysteps:internal:entitlements:evaluate_access" },
  // AR-002 business rule 11: a release is created only by an authenticated
  // CI/deployment service for an approved repository commit — browser
  // administrators cannot register arbitrary source artifacts.
  "ci-deployer": { serviceKey: "ci-deployment-service", audience: "babysteps:internal:deployment:release_create" },
  // AR-002 session 2: drives the release-safety and deployment-window
  // sweeps (rules 32-33, 55, 58) — its own service identity, distinct from
  // AN-001's "scheduler", since it authenticates a different recurring job.
  "deployment-scheduler": { serviceKey: "deployment-pipeline-scheduler", audience: "babysteps:internal:deployment:sweep" },
  // PR-004: drives the bounded, paginated reconciliation sweep and the
  // reconcile-reason branch of the validate-integrity route — its own
  // service identity, distinct from every other scheduled job here.
  "progress-integrity": { serviceKey: "progress-integrity-reconciler", audience: "babysteps:internal:progress:reconcile" },
  "billing-reconciliation": { serviceKey: "billing-reconciliation-service", audience: "babysteps:internal:billing:reconcile" },
  "billing-notification": { serviceKey: "billing-notification-service", audience: "babysteps:internal:billing:renewal_reminder" },
  "billing-recovery": { serviceKey: "billing-recovery-service", audience: "babysteps:internal:billing:grace_expiry" },
  // PR-002: revalidates a deterministic incomplete recovery receipt against
  // current progress — its own service identity, distinct from PR-004's
  // progress-integrity reconciler and billing-recovery above.
  "progress-recovery": { serviceKey: "progress-recovery-reconciler", audience: "babysteps:internal:progress:reconcile_recovery" },
  // EN-003: apply-lifecycle-event and process-due-transitions share this
  // identity — both drive the same transition domain, distinct from
  // entitlement-reconciliation's narrower, source-of-truth-rebuilding role.
  "entitlement-lifecycle": { serviceKey: "entitlement-lifecycle-service", audience: "babysteps:internal:entitlements:lifecycle" },
  "entitlement-reconciliation": { serviceKey: "entitlement-reconciliation-service", audience: "babysteps:internal:entitlements:reconcile_lifecycle" },
};
export type InternalServiceGuardResult =
  | { ok: true; principal: ManagedServicePrincipal }
  | { ok: false; response: NextResponse };

export async function requireInternalService(request: Request, role: PlatformServiceRole,
  now: Date = new Date()): Promise<InternalServiceGuardResult> {
  const assertion = request.headers.get("x-babysteps-service-assertion") ?? "";
  const contract = CONTRACTS[role];
  try {
    const authenticated = authenticatePlatformServiceAssertion({ assertion, audience: contract.audience, now });
    if (authenticated.principal.service_key !== contract.serviceKey) {
      return { ok: false, response: NextResponse.json({ error: "AUTHORIZATION_DENIED" }, { status: 403 }) };
    }
    try {
      getDb().transaction(() => getDb().prepare(
        "insert into platform_service_assertion_replays(principal_id,jti,expires_at) values(?,?,?)",
      ).run(authenticated.principal.id, authenticated.jti, authenticated.expiresAt)).immediate();
    } catch {
      return { ok: false, response: NextResponse.json({ error: "SERVICE_ASSERTION_REPLAYED" }, { status: 409 }) };
    }
    return { ok: true, principal: createManagedServicePrincipal({ id: authenticated.principal.id,
      verified: true, serviceKind: "platform" }) };
  } catch (error) {
    const code = error instanceof InternalAuthorizationDecisionError ? error.code : "SERVICE_AUTHENTICATION_FAILED";
    return { ok: false, response: NextResponse.json({ error: code }, { status: 401 }) };
  }
}
