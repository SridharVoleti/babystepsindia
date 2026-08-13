export const JOURNEY_API_CONTRACTS = {
  learnerRead: { id: "API-EG-018", method: "GET", path: "/v1/learner-apps/{appId}/journey" },
  parentRead: { id: "API-EG-019", method: "GET", path: "/v1/parent/learners/{learnerId}/apps/{appId}/journey" },
  milestone: { id: "API-EG-020", method: "POST", path: "/v1/internal/learner-journey/milestones" },
  lessonProjection: { id: "API-EG-021", method: "AMEND", path: "/v1/internal/learner-app-progress/lessons/{lessonKey}/complete" },
  achievementProjection: { id: "API-EG-022", method: "AMEND", path: "achievement create/revoke" },
  retention: { id: "API-EG-023", method: "POST", path: "/v1/internal/learner-journey/retention-reconcile" },
} as const;
