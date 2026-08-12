export type LearnerHomeCardStatus = "active" | "restoring_access" | "temporarily_unavailable" | "error";

export type LearnerHomeCardBlockedReason =
  | "another_app_in_progress"
  | "starting_reservation_in_progress"
  | "weekly_limit_reached"
  | "no_available_sessions"
  | "app_unavailable"
  | "restoring_access"
  | "maintenance_starts_soon"
  | "temporarily_unavailable"
  | "restoring_service"
  | "security_blocked"
  | "availability_unknown"
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
  operationalAvailability?: {
    state: "available" | "maintenance_soon" | "temporarily_unavailable" | "restoring" | "security_blocked" | "unknown";
    availabilityVersion: number | null;
    learnerMessage: string | null;
    nextMaintenanceStartAt: string | null;
    maintenanceEndsAt: string | null;
    safeStartUntil: string | null;
    expectedReturnAt: string | null;
    startBlocked: boolean;
  };
  session: {
    availableStandardSessions: number;
    nearestStandardExpiryDate: string | null;
    technicalCreditsAvailable: number;
    activeOrResumableSession: { learnerSessionId: string; status: "starting" | "active" | "disconnected" | "resumable" } | null;
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
  serverTime: string;
  composedAt: string;
  nextRecheckAt: string | null;
  cacheMaxAgeSeconds: number;
  selectedLearnerContextVersion: number;
  activeSession: { appId: string; learnerSessionId: string; status: string } | null;
  recentAchievements?: import("@/lib/achievements/service").AchievementView[];
  cards: LearnerHomeCard[];
};

export const LAUNCHER_REFRESH_REASONS = [
  "page_entry", "reload", "pageshow", "learner_unlock", "learner_switch",
  "acknowledged_start", "acknowledged_resume", "acknowledged_cancel_start",
  "resume_later", "finish_now", "visibility_return", "online", "same_browser_invalidation",
  "server_boundary", "manual_refresh", "security_invalidation",
] as const;

export type LauncherRefreshReason = typeof LAUNCHER_REFRESH_REASONS[number];

export type VersionedLearnerHomeResponse = LearnerHomeResponse & {
  capabilities?: Record<string, unknown>;
};
