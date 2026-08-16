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
  | "entitlement-reconciliation"
  | "entitlement-integrity-monitor"
  | "launcher-domain-outbox"
  | "launcher-reconciliation"
  | "app-availability-reader"
  | "consistency-session-domain"
  | "consistency-scheduler"
  | "consistency-reconciliation"
  | "journey-retention"
  | "learning-reminder-scheduler"
  | "learning-reminder-sender"
  | "learning-reminder-reconciliation"
  | "notification-enqueue"
  | "notification-delivery"
  | "notification-reconcile"
  // NT1-G06: API-NT-005 is exactly source-scoped — a source domain's own
  // service principal may read only its own domain's notification status.
  // "notification-read-support" is the one deliberately cross-domain
  // exception, for an allowlisted support-tooling principal (AD-002's
  // future Support Agent role isn't built yet; this is a standalone service
  // identity, not dependent on it).
  | "notification-read-billing"
  | "notification-read-identity"
  | "notification-read-operations"
  | "notification-read-support"
  // NT1-G08: drives the health/alert monitor sweep — its own service
  // identity, distinct from every other notification job here.
  | "notification-health-monitor";
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
  // EN-004: cross-domain integrity reconciliation (bounded sweep + exact
  // paid-cycle/learner-app repair) — its own service identity, distinct
  // from entitlement-reconciliation's narrower chargeback-replay-only role.
  "entitlement-integrity-monitor": { serviceKey: "entitlement-integrity-monitor-service", audience: "babysteps:internal:entitlements:reconcile_integrity" },
  "launcher-domain-outbox": { serviceKey: "learner-launcher-domain-outbox", audience: "babysteps:internal:launcher:invalidate" },
  "launcher-reconciliation": { serviceKey: "learner-launcher-reconciliation", audience: "babysteps:internal:launcher:reconcile_freshness" },
  "app-availability-reader": { serviceKey: "app-availability-reader", audience: "babysteps:internal:apps:availability:read" },
  "consistency-session-domain": { serviceKey: "session-domain-service", audience: "babysteps:internal:consistency:contribute" },
  "consistency-scheduler": { serviceKey: "consistency-scheduler", audience: "babysteps:internal:consistency:finalize" },
  "consistency-reconciliation": { serviceKey: "consistency-reconciliation-service", audience: "babysteps:internal:consistency:reconcile" },
  "journey-retention": { serviceKey: "journey-retention-service", audience: "babysteps:internal:journey:retention" },
  "learning-reminder-scheduler": { serviceKey: "learning-reminder-scheduler",
    audience: "babysteps:internal:learning-reminders:evaluate" },
  "learning-reminder-sender": { serviceKey: "learning-reminder-sender",
    audience: "babysteps:internal:learning-reminders:send" },
  "learning-reminder-reconciliation": { serviceKey: "learning-reminder-reconciliation",
    audience: "babysteps:internal:learning-reminders:reconcile" },
  // NT-001: allowlisted source-service principals for the shared
  // transactional-notification delivery backbone. The provider-webhook
  // route (API-NT-003) is a signature-only boundary, not a
  // requireInternalService caller — it isn't listed here.
  "notification-enqueue": { serviceKey: "notification-enqueue-service",
    audience: "babysteps:internal:notifications:enqueue" },
  "notification-delivery": { serviceKey: "notification-delivery-worker",
    audience: "babysteps:internal:notifications:deliver" },
  "notification-reconcile": { serviceKey: "notification-reconciliation-service",
    audience: "babysteps:internal:notifications:reconcile" },
  "notification-read-billing": { serviceKey: "notification-status-reader-billing",
    audience: "babysteps:internal:notifications:read" },
  "notification-read-identity": { serviceKey: "notification-status-reader-identity",
    audience: "babysteps:internal:notifications:read" },
  "notification-read-operations": { serviceKey: "notification-status-reader-operations",
    audience: "babysteps:internal:notifications:read" },
  "notification-read-support": { serviceKey: "notification-status-reader",
    audience: "babysteps:internal:notifications:read" },
  "notification-health-monitor": { serviceKey: "notification-health-monitor",
    audience: "babysteps:internal:notifications:monitor_health" },
};
export type InternalServiceGuardResult =
  | { ok: true; principal: ManagedServicePrincipal }
  | { ok: false; response: NextResponse };

// NT1-G06: accepts either a single role or a set of roles that share the
// same audience (e.g. every per-source-domain notification-read-* role) —
// the caller is authorized if its service_key matches any one contract in
// the set, letting API-NT-005 accept exactly its own source domain's
// principal plus the one allowlisted cross-domain support principal without
// a second, parallel authorization mechanism.
export async function requireInternalService(request: Request, role: PlatformServiceRole | PlatformServiceRole[],
  now: Date = new Date()): Promise<InternalServiceGuardResult> {
  const assertion = request.headers.get("x-babysteps-service-assertion") ?? "";
  const roles = Array.isArray(role) ? role : [role];
  const contracts = roles.map((r) => CONTRACTS[r]);
  const audience = contracts[0].audience;
  try {
    const authenticated = authenticatePlatformServiceAssertion({ assertion, audience, now });
    if (!contracts.some((contract) => authenticated.principal.service_key === contract.serviceKey)) {
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
