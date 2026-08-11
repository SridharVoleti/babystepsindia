export type LearnerHomeCardStatus = "active" | "restoring_access" | "temporarily_unavailable" | "error";

export type LearnerHomeCardBlockedReason =
  | "another_app_in_progress"
  | "starting_reservation_in_progress"
  | "weekly_limit_reached"
  | "no_available_sessions"
  | "app_unavailable"
  | "restoring_access"
  | null;

export type LearnerHomeCard = {
  appId: string;
  appKey: string;
  appName: string;
  iconAssetKey: string | null;
  shortDescription: string | null;
  status: LearnerHomeCardStatus;
  progress: { currentLevel: string; efficiencyStars: number; milestone: string | null; nextDestination: string } | null;
  progressState: "summary_available" | "learning_not_started" | "summary_hidden_stale_or_blocked";
  lastUpdatedHint: boolean;
  session: {
    availableStandardSessions: number;
    nearestStandardExpiryDate: string | null;
    technicalCreditsAvailable: number;
    activeOrResumableSession: { learnerSessionId: string; status: "starting" | "active" | "disconnected" } | null;
  };
  eligibility: {
    canStart: boolean;
    canResume: boolean;
    blockedReason: LearnerHomeCardBlockedReason;
  };
  primaryAction: "start" | "resume" | "none";
};

export type LearnerHomeResponse = {
  learnerId: string;
  launcherVersion: string;
  activeSession: { appId: string; learnerSessionId: string; status: string } | null;
  cards: LearnerHomeCard[];
};
