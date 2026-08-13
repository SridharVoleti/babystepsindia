import { createHash } from "node:crypto";
import { listOwnedLearners, getParentTimezone } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { composeLearnerHome } from "@/lib/learner-home/service";
import type { LearnerHomeCard } from "@/lib/learner-home/contracts";
import type { AchievementView } from "@/lib/achievements/service";
import { composeParentAttention } from "@/lib/parent-attention/service";
import type { AttentionItem } from "@/lib/parent-attention/contracts";

// PD-001 rule 30-35: the parent overview is read-only with respect to
// learning — session/eligibility/primaryAction encode Start/Resume state
// and are deliberately stripped before this leaves the dashboard composer.
export type ParentDashboardAppCard = Omit<LearnerHomeCard, "session" | "eligibility" | "primaryAction">;

export type ParentDashboardLearnerCard = {
  learnerId: string;
  displayName: string;
  appsOnTrack: { completed: number; total: number } | null;
  currentApps: ParentDashboardAppCard[];
  recentAchievements: AchievementView[];
  attentionPreview: AttentionItem[];
};

export type ParentDashboardResponse = {
  composedAt: string;
  version: string;
  learners: ParentDashboardLearnerCard[];
  partialErrors: Record<string, string>;
};

function toDashboardCard(card: LearnerHomeCard): ParentDashboardAppCard {
  const { session, eligibility, primaryAction, ...rest } = card;
  void session; void eligibility; void primaryAction;
  return rest;
}

// PD-001 rules 57-60: "apps on track" is a plain count of current-week 2/2
// states among apps where weekly cadence is safely readable — never a
// percentage, streak, or cross-app performance comparison.
function appsOnTrack(cards: ParentDashboardAppCard[]): { completed: number; total: number } | null {
  const cadenceApplicable = cards.filter((card) => card.consistency !== undefined);
  if (cadenceApplicable.length === 0) return null;
  const completed = cadenceApplicable.filter((card) => card.consistency!.currentWeekProgress === 2).length;
  return { completed, total: cadenceApplicable.length };
}

function computeVersion(learners: ParentDashboardLearnerCard[]): string {
  return createHash("sha256").update(JSON.stringify(learners)).digest("hex").slice(0, 32);
}

// PD-001 rule 104: reuses PD-003's exact attention composition — this
// function must never derive a second, independent attention algorithm.
export function composeParentDashboard(parentId: string, now: Date): ParentDashboardResponse {
  const ageAsOfDate = calendarDateInTimeZone(getParentTimezone(parentId));
  const owned = listOwnedLearners(parentId, ageAsOfDate);
  const attention = composeParentAttention(parentId, now);

  const learners: ParentDashboardLearnerCard[] = [];
  const partialErrors: Record<string, string> = {};

  for (const learner of owned) {
    try {
      const home = composeLearnerHome(learner.id, "production", now);
      const currentApps = home.cards.map(toDashboardCard);
      const learnerAttention = attention.items.filter((item) => item.learnerId === learner.id);
      learners.push({
        learnerId: learner.id,
        displayName: learner.displayName,
        appsOnTrack: appsOnTrack(currentApps),
        currentApps,
        recentAchievements: home.recentAchievements ?? [],
        attentionPreview: learnerAttention.slice(0, 3),
      });
    } catch {
      partialErrors[learner.id] = "LEARNER_COMPOSITION_FAILED";
    }
  }

  return { composedAt: now.toISOString(), version: computeVersion(learners), learners, partialErrors };
}
