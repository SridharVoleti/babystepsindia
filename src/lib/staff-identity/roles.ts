import type { AuthorizationAction } from "@/lib/authorization/modes";
import { STAFF_ROLE_KEYS, type StaffRoleKey } from "@/lib/staff-identity/contracts";

// Actions any active MFA staff member may call about their OWN identity,
// independent of role (API-AD-002/003/004/005/006 preconditions only ever
// say "active staff session", never a specific role) — checked before the
// per-role table below so Support Agent's empty capability set (business
// rules 43-45; AD-002 defines its real actions later) still lets a staff
// member log in, enroll a passkey and read their own session context.
const SELF_SERVICE_ACTIONS: readonly AuthorizationAction[] = [
  "admin.staff.session_context.read",
  "admin.staff.passkey.registration_options",
  "admin.staff.passkey.register",
  "admin.staff.passkey.assertion_options",
  "admin.staff.passkey.verify",
];

// Business rules 32, 43-51. Static, version-controlled V1 role -> AU-001
// canonical-action mapping — not DB-editable, matching business rule 39.
// No implicit inheritance between roles (business rules 40-41, 49): each
// array is the role's COMPLETE capability set.
export const ROLE_CAPABILITIES: Record<StaffRoleKey, readonly AuthorizationAction[]> = {
  // AD-002 business rules 12, 87-88: exact case-first support workflow.
  support_agent: [
    "admin.support.resolve_customer",
    "admin.support.case.create",
    "admin.support.case.list",
    "admin.support.case.read",
    "admin.support.case.workflow_update",
    "admin.support.case.note.add",
    "admin.support.case.reopen",
  ],

  // Business rule 46: exact BI-001 reassignment + BI-005 refund + the
  // safe billing reads those actions need.
  billing_administrator: [
    "admin.billing.reassignment_case.read",
    "admin.billing.subscription.reassign",
    "admin.billing.refund.create",
    "admin.billing.refund.confirm",
    // AD-003: case-bound billing workspace/orchestration over the same
    // BI-001/BI-005 actions above — requires an active AD-002 case on top
    // of this capability, checked in src/lib/support-cases/billing.ts.
    "admin.support.billing.workspace.read",
    "admin.support.billing.reassignment_eligibility.read",
    "admin.support.billing.reassign",
    "admin.support.billing.refund_eligibility.read",
    "admin.support.billing.refund",
  ],

  // Business rule 48: exact AR-001 app-registry + AR-002 deployment/
  // release/availability/maintenance operations. Also carries the actions
  // this codebase has no other named V1 role for (analytics, progress/
  // entitlement-integrity incidents, entitlement security-revoke) — a
  // documented gap-mapping decision (AD-001 build plan "D3"), not a spec
  // requirement; trivially re-mappable here if a future requirement names
  // a more specific role for them.
  operations_administrator: [
    "admin.app.list",
    "admin.app.create",
    "admin.app.bootstrap",
    "admin.app.read",
    "admin.app.update",
    "admin.app.activate",
    "admin.app.restore",
    "admin.app.delete",
    "admin.deployment.bindings.read",
    "admin.deployment.bindings.create",
    "admin.deployment.bindings.update",
    "admin.deployment.bindings.verify",
    "admin.deployment.releases.read",
    "admin.deployment.release.deploy_staging",
    "admin.deployment.release.approve_production",
    "admin.deployment.deployments.read",
    "admin.deployment.windows.read",
    "admin.deployment.windows.schedule",
    "admin.deployment.windows.reschedule",
    "admin.deployment.windows.cancel",
    "admin.deployment.rollback",
    // src/lib/authorization/deployment-service.ts's handleDeploymentMutation
    // (the shared choke point for the 4 deployments/[deploymentId]/{schedule,
    // reschedule,cancel,promote} routes) checks against this separate,
    // older bare "deployment.*" key family, not the "admin.deployment.
    // windows.*" ones above — both families gate the same operational
    // surface, so Operations Administrator needs both.
    "deployment.schedule",
    "deployment.reschedule",
    "deployment.cancel",
    "deployment.promote",
    "deployment.rollback",
    "admin.app_availability.read",
    "admin.app_availability.manage",
    "admin.analytics.daily.read",
    "admin.analytics.runs.read",
    "admin.analytics.run.retry",
    "admin.entitlements.security_revoke",
    "admin.entitlement_integrity.incident.read",
    "admin.entitlement_integrity.incident.action",
    "admin.progress_integrity.incident.read",
    "admin.progress_integrity.incident.action",
    "admin.progress_integrity.health.read",
    "admin.progress_recovery.incidents.read",
    // AD-004: the immutable operation/change-record spine — orchestrates
    // the AR-001/AR-002/UL-004/AU-004 actions above, never duplicates them.
    "admin.operations.change.create",
    "admin.operations.change.list",
    "admin.operations.change.read",
    "admin.operations.change.workflow_update",
  ],

  // Business rule 50: staff/role governance, IA-003 restoration, platform
  // governance. Deliberately does NOT include Billing/Operations/Support
  // actions (business rules 41-42) — a Platform Administrator needing that
  // work must hold the additional explicit role.
  platform_administrator: [
    "admin.account.restore",
    "admin.staff.invitation.create",
    "admin.staff.status.update",
    "admin.staff.roles.update",
    "admin.staff.list.read",
  ],
};

export function roleHasCapability(roleKeys: readonly string[], action: AuthorizationAction): boolean {
  if (SELF_SERVICE_ACTIONS.includes(action)) return roleKeys.length > 0;
  return roleKeys.some((key) =>
    (ROLE_CAPABILITIES as Record<string, readonly AuthorizationAction[]>)[key]?.includes(action),
  );
}

// Business rules 132-138, 53-54: a pure UI/operating label, never itself
// an authorization decision. True only when a staff account explicitly
// holds all four V1 roles simultaneously.
export function isSuperAdminDisplay(roleKeys: readonly string[]): boolean {
  const active = new Set(roleKeys);
  return STAFF_ROLE_KEYS.every((key) => active.has(key));
}
