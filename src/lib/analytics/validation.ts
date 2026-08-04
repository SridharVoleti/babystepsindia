import { AnalyticsError } from "@/lib/analytics/errors";
import type { AgeBand } from "@/lib/db/types";

const APPROVED_AGE_BANDS: ReadonlySet<string> = new Set<AgeBand>([
  "under_6", "6_7", "8_9", "10_12", "13_15", "16_18", "19_29", "30_49", "50_plus",
]);

// AT-AN-001-28: only these fields may ever reach the contribution
// service — an extra field (raw DOB, exact age, parent id, ...) is
// rejected outright rather than silently ignored.
const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  "activityDate", "learnerId", "appId", "levelKey", "ageBand", "contributionId", "deltas",
]);
const ALLOWED_DELTA_FIELDS = new Set([
  "engagedSeconds", "sessionsStarted", "sessionsCompleted", "sessionsInterrupted", "lessonsCompleted",
]);

export type ContributionDeltas = {
  engagedSeconds: number;
  sessionsStarted: number;
  sessionsCompleted: number;
  sessionsInterrupted: number;
  lessonsCompleted: number;
};

export type ValidatedContribution = {
  activityDate: string;
  learnerId: string;
  appId: string;
  levelKey: string;
  ageBand: AgeBand;
  contributionId: string;
  deltas: ContributionDeltas;
};

function isCalendarDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function mustNonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AnalyticsError("CONTRIBUTION_PAYLOAD_INVALID");
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateContributionPayload(payload: unknown): ValidatedContribution {
  if (!isPlainObject(payload)) throw new AnalyticsError("CONTRIBUTION_PAYLOAD_INVALID");
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_TOP_LEVEL_FIELDS.has(key)) throw new AnalyticsError("CONTRIBUTION_PAYLOAD_UNKNOWN_FIELD");
  }

  if (!isCalendarDate(payload.activityDate)) throw new AnalyticsError("CONTRIBUTION_PAYLOAD_INVALID");
  if (!nonEmptyString(payload.learnerId)) throw new AnalyticsError("CONTRIBUTION_PAYLOAD_INVALID");
  if (!nonEmptyString(payload.appId)) throw new AnalyticsError("CONTRIBUTION_PAYLOAD_INVALID");
  if (!nonEmptyString(payload.levelKey)) throw new AnalyticsError("CONTRIBUTION_PAYLOAD_INVALID");
  if (typeof payload.ageBand !== "string" || !APPROVED_AGE_BANDS.has(payload.ageBand)) {
    throw new AnalyticsError("CONTRIBUTION_PAYLOAD_INVALID");
  }
  if (!nonEmptyString(payload.contributionId)) throw new AnalyticsError("CONTRIBUTION_PAYLOAD_INVALID");
  if (!isPlainObject(payload.deltas)) throw new AnalyticsError("CONTRIBUTION_PAYLOAD_INVALID");
  for (const key of Object.keys(payload.deltas)) {
    if (!ALLOWED_DELTA_FIELDS.has(key)) throw new AnalyticsError("CONTRIBUTION_PAYLOAD_UNKNOWN_FIELD");
  }

  const rawDeltas = payload.deltas;
  const deltas: ContributionDeltas = {
    engagedSeconds: rawDeltas.engagedSeconds === undefined ? 0 : mustNonNegativeInt(rawDeltas.engagedSeconds),
    sessionsStarted: rawDeltas.sessionsStarted === undefined ? 0 : mustNonNegativeInt(rawDeltas.sessionsStarted),
    sessionsCompleted: rawDeltas.sessionsCompleted === undefined ? 0 : mustNonNegativeInt(rawDeltas.sessionsCompleted),
    sessionsInterrupted: rawDeltas.sessionsInterrupted === undefined ? 0 : mustNonNegativeInt(rawDeltas.sessionsInterrupted),
    lessonsCompleted: rawDeltas.lessonsCompleted === undefined ? 0 : mustNonNegativeInt(rawDeltas.lessonsCompleted),
  };

  return {
    activityDate: payload.activityDate,
    learnerId: payload.learnerId,
    appId: payload.appId,
    levelKey: payload.levelKey,
    ageBand: payload.ageBand as AgeBand,
    contributionId: payload.contributionId,
    deltas,
  };
}
