import { createHash } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import { listOwnedLearners, getParentTimezone } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { evaluateAccessForLauncher } from "@/lib/entitlement-access/launcher-cache";
import { getApp } from "@/lib/db/app-registry-repo";
import { readAppAvailability, AppAvailabilityError } from "@/lib/app-availability/service";
import { listLearnerPasskeys } from "@/lib/webauthn/service";
import { listLearningCadenceAttention } from "@/lib/learning-reminders/service";
import { listParentSubscriptions } from "@/lib/billing/bi001-service";
import {
  ATTENTION_SEVERITY_ORDER,
  type AttentionCategory,
  type AttentionItem,
  type AttentionSeverity,
  type ParentAttentionBadge,
  type ParentAttentionResponse,
} from "./contracts";

const ENVIRONMENT = "production";
const BADGE_PREVIEW_SIZE = 3;
const SUMMARY_MAX_LIMIT = 5;
const ATTENTION_LIST_DEFAULT_LIMIT = 20;
const ATTENTION_LIST_MAX_LIMIT = 50;

export class ParentAttentionRequestError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ParentAttentionRequestError"; }
}

// PD-003 rule: this is the only attention composition policy in the app.
// PD-001's dashboard preview and PD-004's shell badge both call
// composeParentAttentionBadge below rather than deriving their own
// second attention algorithm.

function billingItems(parentId: string, now: Date): AttentionItem[] {
  const { items: subscriptions } = listParentSubscriptions(parentId, { limit: 100 });
  const items: AttentionItem[] = [];
  for (const sub of subscriptions) {
    if (sub.paymentState === "past_due_grace" || sub.paymentState === "renewal_failed" || sub.paymentState === "failed") {
      items.push({
        sourceKey: `billing:${sub.id}:payment`,
        category: "billing",
        severity: "action_required",
        learnerId: sub.assignedLearner.id,
        learnerName: sub.assignedLearner.displayName,
        appId: null,
        appName: null,
        subscriptionId: sub.id,
        title: `Payment attention needed for ${sub.product.name}`,
        message: sub.paymentState === "past_due_grace"
          ? "A recent payment didn't go through. Update payment details to keep access active."
          : "A recent payment attempt failed. Update payment details to avoid losing access.",
        route: { href: "/account/subscriptions", label: "Review billing" },
        effectiveAt: sub.graceEndsAt,
        sourceVersion: String(sub.version),
      });
    } else if (sub.cancelAtPeriodEnd && (sub.status === "active" || sub.status === "cancelling")) {
      items.push({
        sourceKey: `billing:${sub.id}:renewal_off`,
        category: "billing",
        severity: "attention",
        learnerId: sub.assignedLearner.id,
        learnerName: sub.assignedLearner.displayName,
        appId: null,
        appName: null,
        subscriptionId: sub.id,
        title: `Renewal off for ${sub.product.name}`,
        message: sub.currentPeriodEnd
          ? `Access continues until ${sub.currentPeriodEnd.slice(0, 10)}. Renewal is currently off.`
          : "Renewal is currently off for this subscription.",
        route: { href: "/account/subscriptions", label: "Manage subscription" },
        effectiveAt: sub.cancellationEffectiveAt ?? sub.currentPeriodEnd,
        sourceVersion: String(sub.version),
      });
    }
  }
  return items;
}

function cadenceItems(parentId: string, now: Date): AttentionItem[] {
  return listLearningCadenceAttention(parentId, "mid_window", now).map((candidate) => ({
    sourceKey: `learning_cadence:${candidate.learnerId}:${candidate.appId}:${candidate.weeklyKey}`,
    category: "learning_cadence",
    severity: "attention",
    learnerId: candidate.learnerId,
    learnerName: candidate.learnerName,
    appId: candidate.appId,
    appName: candidate.appName,
    subscriptionId: null,
    title: `${candidate.appName} sessions are due this week`,
    message: candidate.remainingNormalSessions === 2
      ? `${candidate.learnerName} hasn't started this week's sessions for ${candidate.appName} yet.`
      : `${candidate.learnerName} has one more session left this week for ${candidate.appName}.`,
    route: { href: `/account/learners/${candidate.learnerId}/apps?app=${candidate.appId}`, label: "Open app detail" },
    effectiveAt: candidate.weeklyEndAt,
    sourceVersion: candidate.weeklyKey,
  }));
}

// service_status/access are derived per entitlement row using the same
// side-effect-free cached check past-apps.ts/subscribe-again.ts already
// use (evaluateAccessForLauncher) — never evaluateAccessFresh, which
// mutates on every call.
async function appAttentionItems(learnerId: string, learnerName: string, now: Date): Promise<{ items: AttentionItem[]; hasCurrentApp: boolean }> {
  const rows = await resolveDbClient().all<{ app_id: string }>(
    `select app_id from learner_app_effective_entitlements where learner_id=? and environment=?`,
    [learnerId, ENVIRONMENT],
  );

  const items: AttentionItem[] = [];
  let hasCurrentApp = false;

  for (const row of rows) {
    const app = getApp(row.app_id);
    if (!app) continue;
    const decision = evaluateAccessForLauncher({ learnerId, appId: row.app_id, environment: ENVIRONMENT, now });

    if (decision.allowed && (decision.state === "active" || decision.state === "grace")) {
      hasCurrentApp = true;
      try {
        const availability = readAppAvailability(row.app_id, ENVIRONMENT, now);
        if (availability.operationalAvailability !== "available") {
          items.push({
            sourceKey: `service_status:${learnerId}:${row.app_id}`,
            category: "service_status",
            severity: availability.operationalAvailability === "security_blocked" ? "attention" : "info",
            learnerId, learnerName, appId: row.app_id, appName: app.displayName, subscriptionId: null,
            title: `${app.displayName} is temporarily unavailable`,
            message: availability.learnerMessage ?? "This app is temporarily unavailable right now. No action is needed.",
            route: null,
            effectiveAt: availability.nextMaintenanceStartAt,
            sourceVersion: String(availability.availabilityVersion),
          });
        }
      } catch (error) {
        if (!(error instanceof AppAvailabilityError)) throw error;
      }
    }

    if (decision.state === "suspended_security") {
      items.push({
        sourceKey: `access:${learnerId}:${row.app_id}`,
        category: "access",
        severity: "attention",
        learnerId, learnerName, appId: row.app_id, appName: app.displayName, subscriptionId: null,
        title: `${app.displayName} access is temporarily unavailable`,
        message: "Access to this app has been temporarily restricted for a safety or security reason.",
        route: null,
        effectiveAt: null,
        sourceVersion: String(decision.effectiveEntitlementVersion ?? 0),
      });
    }
  }

  return { items, hasCurrentApp };
}

async function passkeySetupItem(parentId: string, learnerId: string, learnerName: string): Promise<AttentionItem | null> {
  const passkeys = await listLearnerPasskeys(parentId, learnerId);
  if (passkeys.some((passkey) => passkey.status === "active")) return null;
  return {
    sourceKey: `learner_setup:${learnerId}:passkey`,
    category: "learner_setup",
    severity: "action_required",
    learnerId, learnerName, appId: null, appName: null, subscriptionId: null,
    title: `Set up ${learnerName}'s passkey`,
    message: `${learnerName} needs a passkey registered on a device before learning can begin.`,
    route: { href: `/account/learners/${learnerId}/unlock`, label: "Set up passkey" },
    effectiveAt: null,
    sourceVersion: "0",
  };
}

function dedupeBySourceKey(items: AttentionItem[]): AttentionItem[] {
  const seen = new Map<string, AttentionItem>();
  for (const item of items) if (!seen.has(item.sourceKey)) seen.set(item.sourceKey, item);
  return [...seen.values()];
}

// Stable sort: severity, then real due/effective time. Node's Array#sort
// is spec-guaranteed stable, so ties preserve source composition order —
// never learner performance/streak/achievement.
function sortAttentionItems(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const severityDiff = ATTENTION_SEVERITY_ORDER[a.severity] - ATTENTION_SEVERITY_ORDER[b.severity];
    if (severityDiff !== 0) return severityDiff;
    const aTime = a.effectiveAt ? new Date(a.effectiveAt).getTime() : Number.POSITIVE_INFINITY;
    const bTime = b.effectiveAt ? new Date(b.effectiveAt).getTime() : Number.POSITIVE_INFINITY;
    return aTime - bTime;
  });
}

function computeVersion(items: AttentionItem[]): string {
  return createHash("sha256")
    .update(JSON.stringify(items.map((item) => [item.sourceKey, item.sourceVersion, item.severity])))
    .digest("hex")
    .slice(0, 32);
}

// AT-PD-003-40: the earliest known future boundary (grace end / maintenance
// return) across current items — one bounded recheck hint, never a
// continuous-polling contract. Categories outside billing/service_status
// don't have a meaningful "recheck" moment and are excluded.
function computeNextRecheckAt(items: AttentionItem[], now: Date): string | null {
  const boundaryCategories: AttentionCategory[] = ["billing", "service_status"];
  const upcoming = items
    .filter((item) => boundaryCategories.includes(item.category) && item.effectiveAt)
    .map((item) => new Date(item.effectiveAt!).getTime())
    .filter((time) => Number.isFinite(time) && time > now.getTime());
  if (upcoming.length === 0) return null;
  return new Date(Math.min(...upcoming)).toISOString();
}

export async function composeParentAttention(parentId: string, now: Date): Promise<ParentAttentionResponse> {
  const ageAsOfDate = calendarDateInTimeZone(await getParentTimezone(parentId));
  const learners = await listOwnedLearners(parentId, ageAsOfDate);
  const items: AttentionItem[] = [];
  const partialErrors: string[] = [];

  try {
    items.push(...billingItems(parentId, now));
  } catch {
    partialErrors.push("billing");
  }

  for (const learner of learners) {
    try {
      const { items: appItems, hasCurrentApp } = await appAttentionItems(learner.id, learner.displayName, now);
      items.push(...appItems);
      if (hasCurrentApp) {
        const passkeyItem = await passkeySetupItem(parentId, learner.id, learner.displayName);
        if (passkeyItem) items.push(passkeyItem);
      }
    } catch {
      partialErrors.push(`learner:${learner.id}`);
    }
  }

  try {
    items.push(...cadenceItems(parentId, now));
  } catch {
    partialErrors.push("learning_cadence");
  }

  const sorted = sortAttentionItems(dedupeBySourceKey(items));
  return { composedAt: now.toISOString(), version: computeVersion(sorted),
    nextRecheckAt: computeNextRecheckAt(sorted, now), items: sorted, partialErrors };
}

function countBySeverity(items: AttentionItem[], severity: AttentionSeverity): number {
  return items.filter((item) => item.severity === severity).length;
}

export async function composeParentAttentionBadge(parentId: string, now: Date): Promise<ParentAttentionBadge> {
  const full = await composeParentAttention(parentId, now);
  return {
    composedAt: full.composedAt,
    version: full.version,
    actionRequiredCount: countBySeverity(full.items, "action_required"),
    attentionCount: countBySeverity(full.items, "attention"),
    infoCount: countBySeverity(full.items, "info"),
    hasItems: full.items.length > 0,
    preview: full.items.slice(0, BADGE_PREVIEW_SIZE),
  };
}

// --- API-PD-004/API-PD-005 frozen contract adapters (PD3-G01/G02/G03/G04/
// G05/G06/G07/G09) — filter/paginate/bound the one canonical composition
// above; never a second attention algorithm. ---

const ATTENTION_CATEGORIES: AttentionCategory[] = ["billing", "learner_setup", "service_status", "learning_cadence", "access"];
const ATTENTION_SEVERITIES: AttentionSeverity[] = ["action_required", "attention", "info"];

export type ParentAttentionListFilters = {
  learnerId?: string;
  category?: string;
  severity?: string;
  cursor?: string;
  limit?: string;
};

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) throw new ParentAttentionRequestError("INVALID_CURSOR");
  const value = Number.parseInt(cursor, 10);
  if (!Number.isSafeInteger(value) || value < 0) throw new ParentAttentionRequestError("INVALID_CURSOR");
  return value;
}

function parseLimit(limit: string | undefined, max: number, fallback: number): number {
  if (limit === undefined) return fallback;
  if (!/^\d+$/.test(limit)) throw new ParentAttentionRequestError("INVALID_LIMIT");
  const value = Number.parseInt(limit, 10);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new ParentAttentionRequestError("INVALID_LIMIT");
  return value;
}

export type ParentAttentionListResult = ParentAttentionResponse & {
  summary: { actionRequiredCount: number; attentionCount: number; infoCount: number };
  nextCursor: string | null;
};

// API-PD-004: GET /v1/parent/attention-center. Filters apply after the
// canonical compose+sort+dedup pass (AT-PD-003-35: read-only narrowing,
// never a source-state change); pagination applies last, over the already
// severity-sorted list, so page boundaries are deterministic for a given
// attentionVersion.
export async function composeParentAttentionList(parentId: string, filters: ParentAttentionListFilters, now: Date): Promise<ParentAttentionListResult> {
  if (filters.category !== undefined && !ATTENTION_CATEGORIES.includes(filters.category as AttentionCategory)) {
    throw new ParentAttentionRequestError("INVALID_CATEGORY");
  }
  if (filters.severity !== undefined && !ATTENTION_SEVERITIES.includes(filters.severity as AttentionSeverity)) {
    throw new ParentAttentionRequestError("INVALID_SEVERITY");
  }
  const offset = parseCursor(filters.cursor);
  const limit = parseLimit(filters.limit, ATTENTION_LIST_MAX_LIMIT, ATTENTION_LIST_DEFAULT_LIMIT);

  const full = await composeParentAttention(parentId, now);
  // AT-PD-003-44: learnerId scope is enforced by direct ownership inside
  // composeParentAttention itself (every item already only carries this
  // parent's own learners) — filtering here can only ever narrow, never
  // widen, so a foreign learnerId just yields an empty page, not a leak.
  const filtered = full.items.filter((item) =>
    (filters.learnerId === undefined || item.learnerId === filters.learnerId) &&
    (filters.category === undefined || item.category === filters.category) &&
    (filters.severity === undefined || item.severity === filters.severity));

  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const nextCursor = nextOffset < filtered.length ? String(nextOffset) : null;

  return {
    composedAt: full.composedAt,
    version: full.version,
    nextRecheckAt: full.nextRecheckAt,
    items: page,
    partialErrors: full.partialErrors,
    summary: { actionRequiredCount: countBySeverity(filtered, "action_required"),
      attentionCount: countBySeverity(filtered, "attention"), infoCount: countBySeverity(filtered, "info") },
    nextCursor,
  };
}

export type ParentAttentionSummaryFilters = { learnerId?: string; limit?: string };

// API-PD-005: GET /v1/parent/attention-summary. Same source/dedupe/severity
// policy as composeParentAttention — a caller-controlled bounded preview
// (limit<=5), not a second composition policy.
export async function composeParentAttentionSummary(parentId: string, filters: ParentAttentionSummaryFilters, now: Date): Promise<ParentAttentionBadge> {
  const limit = parseLimit(filters.limit, SUMMARY_MAX_LIMIT, BADGE_PREVIEW_SIZE);
  const full = await composeParentAttention(parentId, now);
  const scoped = filters.learnerId === undefined ? full.items : full.items.filter((item) => item.learnerId === filters.learnerId);
  return {
    composedAt: full.composedAt,
    version: full.version,
    actionRequiredCount: countBySeverity(scoped, "action_required"),
    attentionCount: countBySeverity(scoped, "attention"),
    infoCount: countBySeverity(scoped, "info"),
    hasItems: scoped.length > 0,
    preview: scoped.slice(0, limit),
  };
}
