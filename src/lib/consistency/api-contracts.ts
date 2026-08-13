export const CONSISTENCY_API_CONTRACTS = {
  learner: { id: "API-EG-007", method: "GET", path: "/v1/learner-consistency", auth: "learner_mode", target: 2 },
  parent: { id: "API-EG-008", method: "GET", path: "/v1/parent/learners/{learnerId}/consistency", auth: "parent_owner", target: 2 },
  contribution: { id: "API-EG-009", method: "POST", path: "/v1/internal/learner-consistency/standard-session-committed",
    auth: "sc003_session_domain", idempotency: "source_usage_event" },
  finalizer: { id: "API-EG-010", method: "POST", path: "/v1/internal/learner-consistency/finalize-week",
    auth: "consistency_scheduler", idempotency: "week_run_cursor" },
  reconcile: { id: "API-EG-011", method: "POST", path: "/v1/internal/learner-consistency/reconcile",
    auth: "consistency_reconciliation", idempotency: "principal_run_cursor" },
  learnerHome: { id: "API-EG-012", method: "AMEND", path: "/v1/learner-home", auth: "learner_mode", target: 2 },
} as const;
