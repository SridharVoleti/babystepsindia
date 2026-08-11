export const LEARNER_LAUNCHER_API_CONTRACTS = {
  learnerHome: {
    id: "API-UL-001", method: "GET", path: "/v1/learner-home",
    authentication: "exact_au002_learner_mode", conditional: "If-None-Match",
    response: "200 versioned launcher or exact-context 304", sideEffects: "none",
  },
  parentPastApps: {
    id: "API-UL-002", method: "GET", path: "/v1/parent/learners/{learnerId}/past-apps",
    authentication: "owning_parent_management", conditional: "If-None-Match",
    response: "200 versioned past apps or exact parent-context 304", sideEffects: "none",
  },
  invalidate: {
    id: "API-UL-009", method: "POST", path: "/v1/internal/learner-launcher/invalidate",
    authentication: "exact_au004_domain_outbox", idempotency: "eventId",
    response: "safe invalidation version and affected scope", browserPush: false,
  },
  reconcileFreshness: {
    id: "API-UL-010", method: "POST", path: "/v1/internal/learner-launcher/reconcile-freshness",
    authentication: "exact_au004_launcher_reconciliation", idempotency: "runIdempotencyKey",
    response: "bounded aggregate freshness reconciliation", domainMutation: false,
  },
} as const;

export const APP_AVAILABILITY_API_CONTRACTS = {
  appAvailabilityRead: {
    id: "API-UL-011", method: "GET", path: "/v1/internal/apps/{appId}/availability",
    authentication: "exact_platform_availability_reader", response: "authoritative state and next window",
    sideEffects: "none", cache: "no-store",
  },
  adminAvailabilityRead: {
    id: "API-UL-012", method: "GET", path: "/v1/admin/apps/{appId}/availability",
    authentication: "app_availability_read_recent_reauth", response: "state windows and overlap count",
  },
  maintenanceWindowManage: {
    id: "API-UL-013", method: "POST/PATCH", path: "/v1/admin/apps/{appId}/maintenance-windows",
    authentication: "app_availability_manage_recent_reauth", idempotency: "app_environment_key",
  },
  availabilityTransition: {
    id: "API-UL-014", method: "POST", path: "/v1/admin/apps/{appId}/availability-transition",
    authentication: "app_availability_manage_recent_reauth", excludes: "security_blocked",
  },
  startAvailabilityGate: {
    id: "API-UL-015", method: "INTERNAL", path: "SC-003 start transaction gate",
    rule: "server_now_plus_3900_seconds_lte_maintenance_start", mutationOrder: "before_funding",
  },
} as const;
