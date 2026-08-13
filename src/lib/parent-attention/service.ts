import { createHash } from "node:crypto";
import { getDb } from "@/lib/db/client";
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
  type AttentionItem,
  type ParentAttentionBadge,
  type ParentAttentionResponse,
} from "./contracts";

const ENVIRONMENT = "production";
const BADGE_PREVIEW_SIZE = 3;

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
function appAttentionItems(learnerId: string, learnerName: string, now: Date): { items: AttentionItem[]; hasCurrentApp: boolean } {
  const rows = getDb().prepare(
    `select app_id from learner_app_effective_entitlements where learner_id=? and environment=?`,
  ).all(learnerId, ENVIRONMENT) as { app_id: string }[];

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

function passkeySetupItem(parentId: string, learnerId: string, learnerName: string): AttentionItem | null {
  const passkeys = listLearnerPasskeys(parentId, learnerId);
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

export function composeParentAttention(parentId: string, now: Date): ParentAttentionResponse {
  const ageAsOfDate = calendarDateInTimeZone(getParentTimezone(parentId));
  const learners = listOwnedLearners(parentId, ageAsOfDate);
  const items: AttentionItem[] = [];
  const partialErrors: string[] = [];

  try {
    items.push(...billingItems(parentId, now));
  } catch {
    partialErrors.push("billing");
  }

  for (const learner of learners) {
    try {
      const { items: appItems, hasCurrentApp } = appAttentionItems(learner.id, learner.displayName, now);
      items.push(...appItems);
      if (hasCurrentApp) {
        const passkeyItem = passkeySetupItem(parentId, learner.id, learner.displayName);
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
  return { composedAt: now.toISOString(), version: computeVersion(sorted), items: sorted, partialErrors };
}

export function composeParentAttentionBadge(parentId: string, now: Date): ParentAttentionBadge {
  const full = composeParentAttention(parentId, now);
  return {
    composedAt: full.composedAt,
    version: full.version,
    actionRequiredCount: full.items.filter((item) => item.severity === "action_required").length,
    attentionCount: full.items.filter((item) => item.severity === "attention").length,
    hasItems: full.items.length > 0,
    preview: full.items.slice(0, BADGE_PREVIEW_SIZE),
  };
}
