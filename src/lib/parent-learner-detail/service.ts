import { createHash } from "node:crypto";
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
  // PD2-G06: which non-authoritative presentation components failed to
  // compose, so the caller can render the rest of the page safely instead
  // of failing the whole detail.
  componentErrors: string[];
};

// One bounded selected-app expansion — PD-002 rule: no full multi-app
// comparison table, exactly one detail composed per call. PD2-G06:
// achievements/attention are each independently fault-isolated — a failure
// in one never takes down the app/progress detail itself.
export function composeParentAppDetail(parentId: string, learnerId: string, appId: string, now: Date): ParentAppDetail {
  const detail = composeParentLearnerDetail(parentId, learnerId, now);
  const current = detail.current.find((card) => card.appId === appId) ?? null;
  const past = detail.past.find((card) => card.appId === appId) ?? null;
  if (!current && !past) throw new ParentLearnerDetailError("RESOURCE_NOT_FOUND");

  const componentErrors: string[] = [];
  let recentAchievements: AchievementView[] = [];
  try {
    recentAchievements = listAchievements({ learnerId, appId, limit: 3 }).achievements;
  } catch {
    componentErrors.push("achievements");
  }

  let attention: AttentionItem[] = [];
  try {
    attention = composeParentAttention(parentId, now).items
      .filter((item) => item.learnerId === learnerId && (item.appId === appId || item.appId === null));
  } catch {
    componentErrors.push("attention");
  }

  return {
    appId,
    appName: current?.appName ?? past!.appName,
    scope: current ? "current" : "past",
    current, past,
    recentAchievements,
    journeyHref: `/account/learners/${learnerId}/apps/${appId}/journey`,
    attention,
    componentErrors,
  };
}

// --- API-PD-002/API-PD-003 frozen contract adapters (PD2-G01/G02/G03/G04/G05) ---
// Both compose entirely from composeParentLearnerDetail/composeParentAppDetail
// above — no second educational-composition path.

export type ParentLearnerAppSelector = { appId: string; appName: string };

export type ParentLearnerAppSelectors = {
  currentApps: ParentLearnerAppSelector[];
  pastApps: ParentLearnerAppSelector[];
  compositionVersion: string;
};

function toSelector(card: { appId: string; appName: string }): ParentLearnerAppSelector {
  return { appId: card.appId, appName: card.appName };
}

// API-PD-003: GET /v1/parent/learners/{learnerId}/apps — compact Current/Past
// selectors only, no per-app detail payload.
export function listParentLearnerAppSelectors(parentId: string, learnerId: string, now: Date): ParentLearnerAppSelectors {
  const detail = composeParentLearnerDetail(parentId, learnerId, now);
  const currentApps = detail.current.map(toSelector);
  const pastApps = detail.past.map(toSelector);
  const compositionVersion = createHash("sha256")
    .update(JSON.stringify([currentApps, pastApps]))
    .digest("hex")
    .slice(0, 32);
  return { currentApps, pastApps, compositionVersion };
}

export type ParentLearnerDetailSection = "current" | "past";

export class ParentLearnerDetailStaleSelectionError extends Error {
  constructor() { super("STALE_SELECTION"); this.name = "ParentLearnerDetailStaleSelectionError"; }
}

export type ParentLearnerDetailComposite = {
  learner: { learnerId: string; displayName: string };
  header: { learnerId: string; displayName: string; currentCount: number; pastCount: number };
  selectors: { current: ParentLearnerAppSelector[]; past: ParentLearnerAppSelector[] };
  selectedAppDetail: ParentAppDetail | null;
  componentErrors: string[];
  detailVersion: string;
  composedAt: string;
};

// API-PD-002: GET /v1/parent/learners/{learnerId}/detail?section=current|past&appId?
// PD2-G03/G04: validates the section/appId selection contract, including the
// frozen 409 stale-selection semantics (an appId that is real for this
// learner but not a member of the requested section).
export function composeParentLearnerDetailContract(
  parentId: string, learnerId: string,
  input: { section: ParentLearnerDetailSection; appId?: string }, now: Date,
): ParentLearnerDetailComposite {
  const detail = composeParentLearnerDetail(parentId, learnerId, now);
  const sectionList = input.section === "current" ? detail.current : detail.past;
  const otherList = input.section === "current" ? detail.past : detail.current;

  let selectedAppId = input.appId;
  if (selectedAppId === undefined) {
    selectedAppId = sectionList[0]?.appId;
  } else if (!sectionList.some((card) => card.appId === selectedAppId)) {
    // Real for this learner, just not in the requested section — a stale
    // client-held selection (AT-PD-002 stale-selection case), not a foreign
    // or nonexistent app (composeParentAppDetail below still throws
    // RESOURCE_NOT_FOUND for those, mapped to 404 by the route).
    if (otherList.some((card) => card.appId === selectedAppId)) {
      throw new ParentLearnerDetailStaleSelectionError();
    }
  }

  const selectedAppDetail = selectedAppId ? composeParentAppDetail(parentId, learnerId, selectedAppId, now) : null;
  const composedAt = now.toISOString();
  const detailVersion = createHash("sha256")
    .update(JSON.stringify({ detail, section: input.section, selectedAppId, selectedAppDetail }))
    .digest("hex")
    .slice(0, 32);

  return {
    learner: { learnerId: detail.learnerId, displayName: detail.displayName },
    header: { learnerId: detail.learnerId, displayName: detail.displayName,
      currentCount: detail.current.length, pastCount: detail.past.length },
    selectors: { current: detail.current.map(toSelector), past: detail.past.map(toSelector) },
    selectedAppDetail,
    componentErrors: selectedAppDetail?.componentErrors ?? [],
    detailVersion,
    composedAt,
  };
}
