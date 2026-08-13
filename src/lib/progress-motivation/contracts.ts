export const MOTIVATION_DISPLAY_TYPES = ["steps", "percentage", "label", "none"] as const;
export type MotivationDisplayType = typeof MOTIVATION_DISPLAY_TYPES[number];

type MotivationBase = { motivationalMessage?: string };
export type MotivationProgress =
  | (MotivationBase & { displayType: "steps"; currentStepKey?: string; currentStepLabel?: string;
      nextStepLabel?: string; stepPosition: number; stepCount: number })
  | (MotivationBase & { displayType: "percentage"; percentageValue: number })
  | (MotivationBase & { displayType: "label"; progressLabel: string })
  | (MotivationBase & { displayType: "none" });

export type ProgressSummary = {
  currentLevel: string;
  efficiencyStars: number;
  milestone: string | null;
  nextDestination: string;
  motivationProgress?: MotivationProgress;
};

export const PROGRESS_MOTIVATION_API_CONTRACTS = {
  write: { id: "API-EG-015", method: "AMEND", path: "/v1/internal/learner-app-progress/summary",
    maxBytes: 4096, authority: "app_owned" },
  reads: { id: "API-EG-016", method: "AMEND", paths: ["parent progress summaries", "/v1/learner-home"],
    normalization: "none" },
  release: { id: "API-EG-017", method: "AMEND", path: "PR-003/AR-002 release summary contract",
    validation: "shape_only" },
} as const;
