import { CADENCE_CELEBRATION_CONTEXT_VERSION } from "@/lib/deployment-manifest/schema";

export type CadenceCelebrationContext = {
  eligible: true;
  weeklyKey: string;
  cadenceTarget: 2;
  completedSessions: 2;
  currentStreakWeeks: number;
  longestStreakWeeks: number;
  appRef: { appId: string; appKey: string; displayName: string };
  celebrationContextVersion: typeof CADENCE_CELEBRATION_CONTEXT_VERSION;
};

export type CadenceCelebrationEligibility = CadenceCelebrationContext | { eligible: false };

export const CADENCE_CELEBRATION_API_CONTRACTS = {
  context: { id: "API-EG-013", method: "GET", path: "/v1/internal/learner-consistency/{appId}/cadence-completion-context",
    auth: "la004_or_session_domain", query: ["sessionId"] },
  completion: { id: "API-EG-014", method: "AMEND", path: "/v1/internal/learner-sessions/{sessionId}/complete",
    responseField: "cadenceCelebrationContext", failureMode: "nonblocking" },
} as const;
