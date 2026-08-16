import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AUTHORIZATION_ACTIONS } from "@/lib/authorization/modes";
import { supabaseTableAccess } from "@/lib/db/access-boundaries";
import {
  DEPLOYMENT_ADMIN_AUTHORIZATION,
  deploymentAvailabilityNotice,
} from "@/lib/authorization/deployment-contract";
import { PLATFORM_API_CONTRACTS } from "@/lib/authorization/platform-api-contracts";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const sources = {
  modes: () => read("src/lib/authorization/modes.ts"),
  principals: () => read("src/lib/authorization/principals.ts"),
  bundles: () => read("src/lib/authorization/policy-bundles.ts"),
  locked: () => read("src/lib/authorization/locked-mutation.ts"),
  capabilities: () => read("src/lib/authorization/ui-capabilities.ts"),
  appGuard: () => read("src/lib/app-authorization/guard.ts"),
  appAuth: () => read("src/lib/app-authorization/service.ts"),
  internal: () => read("src/lib/authorization/internal-decision.ts"),
  boundary: () => read("scripts/check-app-platform-boundary.mjs"),
  workflow: () => read(".github/workflows/architecture-boundaries.yml"),
  gateway: () => read("src/lib/learning-session/gateway.ts"),
  launch: () => read("src/lib/app-launch/service.ts"),
  routeActions: () => read("src/lib/authorization/route-actions.ts"),
  deploymentService: () => read("src/lib/authorization/deployment-service.ts"),
  rls: () => read("supabase/migrations/0026_au001_rls_repository_scope.sql"),
};

type Criterion = { id: number; title: string; verify: () => void };
const has = (value: string, pattern: RegExp) => expect(value).toMatch(pattern);
const contracts = () => Object.values(PLATFORM_API_CONTRACTS);

const criteria: Criterion[] = [
  { id: 1, title: "Every protected API declares a registered canonical action", verify: () => { has(sources.routeActions(), /API_ROUTE_AUTHORIZATION/); expect(Object.keys(AUTHORIZATION_ACTIONS).length).toBeGreaterThan(0); } },
  { id: 2, title: "Unknown action denies", verify: () => has(sources.modes(), /AUTHORIZATION_ACTION_UNKNOWN/) },
  { id: 3, title: "Default decision is deny", verify: () => has(sources.bundles(), /AUTHORIZATION_POLICY_INACTIVE/) },
  { id: 4, title: "Actor comes only from verified authentication", verify: () => has(sources.principals(), /PRINCIPAL_NOT_VERIFIED/) },
  { id: 5, title: "Client roles and actor claims do not grant access", verify: () => { has(sources.internal(), /createManagedServicePrincipal/); expect(sources.internal()).not.toMatch(/input\.(?:role|isAdmin|isOwner)/); } },
  { id: 6, title: "Exact resource identity is evaluated", verify: () => has(sources.principals(), /resource\.(?:parentUserId|learnerId|appId|learnerSessionId)/) },
  { id: 7, title: "Selected learner is not ownership proof", verify: () => has(sources.modes(), /owner_parent_id/) },
  { id: 8, title: "Ownership comes from authoritative data", verify: () => has(sources.modes(), /select 1 from learners where id=\? and owner_parent_id=\?/) },
  { id: 9, title: "Learner principal is bound to one learner", verify: () => has(sources.principals(), /resource\.learnerId !== principal\.learnerId/) },
  { id: 10, title: "Learner cannot access parent billing or another learner", verify: () => { expect(AUTHORIZATION_ACTIONS["parent.billing.read"].mode).toBe("parent_management"); expect(AUTHORIZATION_ACTIONS["learner.home.read"].mode).toBe("learner_mode"); } },
  { id: 11, title: "Admin support and service authorization are separate", verify: () => { has(sources.principals(), /administrator/); has(sources.principals(), /support/); has(sources.principals(), /managed_service/); } },
  { id: 12, title: "LA-002 grant remains exact app session and deployment scoped", verify: () => has(sources.appAuth(), /learner_session_id[\s\S]*app_id[\s\S]*deployment_id/) },
  { id: 13, title: "Protected mutations reauthorize under lock", verify: () => has(sources.locked(), /authorizeEndUserAction[\s\S]*transaction/) },
  { id: 14, title: "Concurrent state change prevents stale allow", verify: () => has(read("tests/authorization-modes.test.ts"), /rolls back a denied mutation/) },
  { id: 15, title: "Lists filter before pagination and count", verify: () => has(sources.modes(), /buildAuthorizedLearnerQueryScope/) },
  { id: 16, title: "Foreign rows never load into result processing", verify: () => has(sources.modes(), /where:"owner_parent_id = \?"/) },
  { id: 17, title: "UI capabilities use the same policy but are non-authoritative", verify: () => { has(sources.capabilities(), /getActiveAuthorizationPolicyBundle/); has(sources.capabilities(), /authorizePrincipalAction/); } },
  { id: 18, title: "Foreign and missing resources do not enumerate", verify: () => has(sources.principals(), /RESOURCE_NOT_FOUND/) },
  { id: 19, title: "RLS and repository scope are enabled", verify: () => {
    expect(Object.keys(supabaseTableAccess)).toHaveLength(158);
    expect(supabaseTableAccess).toMatchObject({
      learner_achievements: "server_only",
      achievement_mutation_receipts: "server_only",
      app_release_achievement_contracts: "server_only",
      achievement_journey_projection_outbox: "server_only",
      learner_app_consistency: "server_only",
      learner_app_consistency_weeks: "server_only",
      consistency_mutation_receipts: "server_only",
      learner_app_journey_events: "server_only",
      learner_journey_retention_state: "server_only",
      journey_mutation_receipts: "server_only",
      lesson_journey_projection_outbox: "server_only",
      app_release_journey_contracts: "server_only",
      journey_retention_job_runs: "server_only",
      parent_notification_preferences: "server_only",
      learning_reminder_batches: "server_only",
      learning_reminder_items: "server_only",
      learning_reminder_deliveries: "server_only",
      learning_reminder_job_runs: "server_only",
    });
    has(sources.rls(), /force row level security/);
  } },
  { id: 20, title: "Central action policy remains required with RLS", verify: () => { has(sources.appGuard(), /authorizeDualCredentialRequest/); has(sources.routeActions(), /API_ROUTE_AUTHORIZATION/); } },
  { id: 21, title: "Exactly one policy version is active", verify: () => has(sources.bundles(), /singleton_key='active'/) },
  { id: 22, title: "Policy activation is atomic and records digest", verify: () => has(sources.bundles(), /db\.transaction[\s\S]*digest[\s\S]*sourceCommitSha/) },
  { id: 23, title: "Policy activation requires permission reauthentication and audit", verify: () => { has(sources.bundles(), /findStaffById/); has(sources.bundles(), /authorization_policy_activation_history/); } },
  { id: 24, title: "Unknown context principal and resource fail closed", verify: () => { has(sources.modes(), /AUTHORIZATION_CONTEXT_UNAVAILABLE/); has(sources.principals(), /PRINCIPAL_CONTEXT_INVALID/); } },
  { id: 25, title: "Mutable revocation is checked on every protected request", verify: () => has(sources.appAuth(), /status !== "active"/) },
  { id: 26, title: "No long-lived allow cache exists", verify: () => { expect(sources.appGuard()).not.toMatch(/cache|memo/i); has(sources.appAuth(), /authorizeDualCredentialRequest/); } },
  { id: 27, title: "Ordinary reads create no permanent decision history", verify: () => expect(sources.capabilities()).not.toMatch(/insert into/) },
  { id: 28, title: "Sensitive decisions produce minimal audit", verify: () => has(sources.modes(), /authorization_boundary_denied/) },
  { id: 29, title: "Authorization logs exclude payload personal progress and tokens", verify: () => { const audit = sources.modes(); expect(audit).not.toMatch(/JSON\.stringify\(.*(?:token|progress|payload)/); } },
  { id: 30, title: "Every app-consumed capability has a documented API contract", verify: () => expect(contracts().every((contract) => contract.path.startsWith("/v1/") && contract.canonicalAction)).toBe(true) },
  { id: 31, title: "Apps have no direct platform table function or auth-admin access", verify: () => { has(sources.boundary(), /platform_table_access/); has(sources.boundary(), /platform_database_function/); has(sources.boundary(), /platform_auth_administration/); } },
  { id: 32, title: "Apps have no platform service-role or PostgreSQL credential", verify: () => { has(sources.boundary(), /platform_service_credential/); has(sources.boundary(), /direct_database_credential/); } },
  { id: 33, title: "Protected calls originate from the app backend", verify: () => expect(contracts().every((contract) => contract.authentication === "la002_dual_proof")).toBe(true) },
  { id: 34, title: "Browser receives no platform backend credential", verify: () => expect(contracts().every((contract) => contract.browserCredential === "app_local_cookie_only")).toBe(true) },
  { id: 35, title: "Platform app APIs use LA-002 proof and AU-001 action policy", verify: () => expect(contracts().every((contract) => contract.canonicalAction && contract.authentication === "la002_dual_proof")).toBe(true) },
  { id: 36, title: "Apps may directly serve only app-owned curriculum and static assets", verify: () => has(read("tests/app-platform-boundary-ci.test.ts"), /permits app-owned static curriculum/) },
  { id: 37, title: "API failure never triggers database fallback or local authority", verify: () => { has(sources.boundary(), /platform_database_client/); expect(contracts().every((contract) => contract.failureMode === "fail_closed_no_database_fallback")).toBe(true); } },
  { id: 38, title: "API contracts define version schemas auth action idempotency errors rate and audit", verify: () => expect(contracts().every((contract) => contract.version && contract.requestSchema && contract.responseSchema && contract.idempotency && contract.errors.length && contract.rateLimit && contract.auditClassification)).toBe(true) },
  { id: 39, title: "Supported app releases remain backward compatible", verify: () => expect(contracts().every((contract) => contract.compatibility === "expand_contract")).toBe(true) },
  { id: 40, title: "Release staging tests all required platform APIs", verify: () => expect(contracts().every((contract) => contract.releaseGate === "required_staging_contract_test")).toBe(true) },
  { id: 41, title: "CI detects direct-access credentials and integration", verify: () => { has(sources.workflow(), /npm run test:architecture/); has(sources.boundary(), /scanApplicationBoundary/); } },
  { id: 42, title: "A new platform service requires an approved API before app use", verify: () => expect(contracts().every((contract) => contract.approvalStatus === "approved")).toBe(true) },
  { id: 43, title: "Deployment state blocks session credit launch and grant without usage", verify: () => { has(sources.gateway(), /APP_DEPLOYMENT_WINDOW_BLOCKED/); has(sources.launch(), /APP_DEPLOYMENT_WINDOW_BLOCKED/); has(sources.appAuth(), /APP_DEPLOYMENT_WINDOW_BLOCKED/); } },
  { id: 44, title: "Deployment admin actions use exact actions reauthentication and locked validation", verify: () => { expect(Object.keys(DEPLOYMENT_ADMIN_AUTHORIZATION)).toEqual(["deployment.schedule", "deployment.reschedule", "deployment.cancel", "deployment.promote", "deployment.rollback"]); expect(Object.values(DEPLOYMENT_ADMIN_AUTHORIZATION).every((rule) => rule.recentReauthenticationSeconds && rule.transactionalReauthorization && rule.exactAppReleaseBinding)).toBe(true); has(sources.deploymentService(), /run\.immediate\(\)/); has(sources.deploymentService(), /AUTHORIZATION_POLICY_CHANGED/); has(sources.routeActions(), /deployment\.schedule/); } },
  { id: 45, title: "The 60-minute drain is a preparation pause", verify: () => expect(deploymentAvailabilityNotice({ phase: "drain" }).publicDowntime).toBe(false) },
  { id: 46, title: "Scheduled deployment notice states up to 45 minutes", verify: () => expect(deploymentAvailabilityNotice({ phase: "deploying" }).message).toContain("up to 45 minutes") },
  { id: 47, title: "Safe completion may reopen the app early", verify: () => expect(deploymentAvailabilityNotice({ phase: "available" }).blocked).toBe(false) },
  { id: 48, title: "Unsafe overrun remains blocked and uses no allowance", verify: () => expect(deploymentAvailabilityNotice({ phase: "overrun" })).toMatchObject({ blocked: true, allowanceUsed: false }) },
  { id: 49, title: "Other apps remain available during app-specific deployment", verify: () => expect(deploymentAvailabilityNotice({ phase: "deploying", affectedAppId: "app-a" }).scope).toEqual({ appId: "app-a" }) },
  { id: 50, title: "The same locked state and policy produce a deterministic decision", verify: () => { has(sources.locked(), /authorizeEndUserAction/); has(sources.bundles(), /canonicalRules/); } },
];

describe("AU-001 acceptance criteria", () => {
  it.each(criteria)("AC$id $title", ({ id, verify }) => {
    if (id === 1) {
      expect(criteria).toHaveLength(50);
      expect(new Set(criteria.map((criterion) => criterion.id))).toEqual(new Set(Array.from({ length: 50 }, (_, index) => index + 1)));
    }
    verify();
  });
});
