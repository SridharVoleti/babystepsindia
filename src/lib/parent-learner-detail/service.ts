import { getOwnedLearner, getParentTimezone, LearnerCreationError } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { composeLearnerHome } from "@/lib/learner-home/service";
import type { LearnerHomeCard } from "@/lib/learner-home/contracts";
import { listPastApps, type PastAppCard } from "@/lib/learner-home/past-apps";
import { listAchievements, type AchievementView } from "@/lib/achievements/service";
import { composeParentAttention } from "@/lib/parent-attention/service";
import type { AttentionItem } from "@/lib/parent-attention/contracts";

export class ParentLearnerDetailError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ParentLearnerDetailError"; }
}

// PD-002: read-only, same session/eligibility/primaryAction strip as PD-001
// — this module has no educational-mutation surface at all.
export type ParentLearnerDetailAppCard = Omit<LearnerHomeCard, "session" | "eligibility" | "primaryAction">;

export type ParentLearnerDetailResponse = {
  learnerId: string;
  displayName: string;
  current: ParentLearnerDetailAppCard[];
  past: PastAppCard[];
};

function toDetailCard(card: LearnerHomeCard): ParentLearnerDetailAppCard {
  const { session, eligibility, primaryAction, ...rest } = card;
  void session; void eligibility; void primaryAction;
  return rest;
}

export function composeParentLearnerDetail(parentId: string, learnerId: string, now: Date): ParentLearnerDetailResponse {
  let learner;
  try {
    learner = getOwnedLearner(parentId, learnerId, calendarDateInTimeZone(getParentTimezone(parentId)));
  } catch (error) {
    if (error instanceof LearnerCreationError && error.code === "LEARNER_NOT_FOUND") {
      throw new ParentLearnerDetailError("RESOURCE_NOT_FOUND");
    }
    throw error;
  }
  const home = composeLearnerHome(learnerId, "production", now);
  const past = listPastApps(parentId, learnerId, now);
  return { learnerId, displayName: learner.displayName, current: home.cards.map(toDetailCard), past };
}

export type ParentAppDetail = {
  appId: string;
  appName: string;
  scope: "current" | "past";
  current: ParentLearnerDetailAppCard | null;
  past: PastAppCard | null;
  recentAchievements: AchievementView[];
  journeyHref: string;
  attention: AttentionItem[];
};

// One bounded selected-app expansion — PD-002 rule: no full multi-app
// comparison table, exactly one detail composed per call.
export function composeParentAppDetail(parentId: string, learnerId: string, appId: string, now: Date): ParentAppDetail {
  const detail = composeParentLearnerDetail(parentId, learnerId, now);
  const current = detail.current.find((card) => card.appId === appId) ?? null;
  const past = detail.past.find((card) => card.appId === appId) ?? null;
  if (!current && !past) throw new ParentLearnerDetailError("RESOURCE_NOT_FOUND");

  const { achievements } = listAchievements({ learnerId, appId, limit: 3 });
  const attention = composeParentAttention(parentId, now).items
    .filter((item) => item.learnerId === learnerId && (item.appId === appId || item.appId === null));

  return {
    appId,
    appName: current?.appName ?? past!.appName,
    scope: current ? "current" : "past",
    current, past,
    recentAchievements: achievements,
    journeyHref: `/account/learners/${learnerId}/apps/${appId}/journey`,
    attention,
  };
}
