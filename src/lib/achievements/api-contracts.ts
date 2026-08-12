export const ACHIEVEMENT_API_CONTRACTS = {
  create: { id: "API-EG-001", method: "POST", path: "/v1/internal/learner-achievements",
    authentication: "exact_la002_au004_achievement_write", cache: "no-store", idempotency: "required" },
  revoke: { id: "API-EG-002", method: "POST", path: "/v1/internal/learner-achievements/{achievementId}/revoke",
    authentication: "exact_app_scoped_assertion", cache: "no-store", idempotency: "required" },
  learnerFeed: { id: "API-EG-003", method: "GET", path: "/v1/learner-achievements",
    authentication: "exact_au002_learner_mode", cache: "private_no_store", pagination: "earnedAt_id_cursor" },
  parentFeed: { id: "API-EG-004", method: "GET", path: "/v1/parent/learners/{learnerId}/achievements",
    authentication: "owning_parent_management", cache: "private_no_store", pagination: "earnedAt_id_cursor" },
  releaseContract: { id: "API-EG-005", method: "GET", path: "/v1/internal/apps/{appId}/achievement-contract",
    authentication: "exact_app_environment_release", cache: "no-store" },
  learnerHomePreview: { id: "API-EG-006", method: "AMEND", path: "GET /v1/learner-home",
    authentication: "exact_au002_learner_mode", cache: "existing_conditional_etag", boundedCount: 3 },
} as const;
