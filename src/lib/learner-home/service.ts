import { createHash } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { evaluateAccessForLauncher } from "@/lib/entitlement-access/launcher-cache";
import { getApp } from "@/lib/db/app-registry-repo";
import { getPublishedDeployment } from "@/lib/deployment-production/service";
import { buildStandardAllowance } from "@/lib/session-credit-standard/service";
import { listTechnicalCredits } from "@/lib/session-credit/service";
import { getParentTimezone } from "@/lib/db/learner-repo";
import { readLearnerAppSummarySnapshot } from "@/lib/app-progress/summary-read";
import { readProgressVisibilitySnapshot } from "@/lib/progress-integrity/service";
import type { LearnerHomeCard, LearnerHomeCardBlockedReason, LearnerHomeResponse } from "./contracts";

type ActiveSession = { id: string; app_id: string; status: "starting" | "active" | "disconnected" };

function resolveParentTimezone(learnerId: string): string {
  const learner = getDb().prepare("select owner_parent_id from learners where id=?").get(learnerId) as
    { owner_parent_id: string } | undefined;
  return learner ? getParentTimezone(learner.owner_parent_id) : "Asia/Kolkata";
}

function errorCard(appId: string): LearnerHomeCard {
  return {
    appId, appKey: appId, appName: "Unavailable", iconAssetKey: null, shortDescription: null,
    status: "error", progress: null, progressState: "summary_hidden_stale_or_blocked", lastUpdatedHint: false,
    session: { availableStandardSessions: 0, nearestStandardExpiryDate: null, technicalCreditsAvailable: 0, activeOrResumableSession: null },
    eligibility: { canStart: false, canResume: false, blockedReason: "no_available_sessions" },
    primaryAction: "none",
  };
}

// UL-001 rules 4-17, 43-44: enumerates candidate apps from the raw
// effective-entitlements table (a bare app_id list — the only place a raw
// scan is appropriate, since no function lists a learner's effective
// entitlements across apps), then resolves each app's card independently
// so one app's failure can never fail the whole response.
function buildCard(
  learnerId: string, appId: string, environment: string, now: Date,
  timezone: string, technicalCreditsByApp: Map<string, number>, activeSession: ActiveSession | null,
): LearnerHomeCard | null {
  const decision = evaluateAccessForLauncher({ learnerId, appId, environment, now });
  if (!decision.allowed || (decision.state !== "active" && decision.state !== "grace")) return null;

  const row = getDb().prepare(
    `select integrity_state from learner_app_effective_entitlements where learner_id=? and app_id=? and environment=?`,
  ).get(learnerId, appId, environment) as { integrity_state: string } | undefined;

  const app = getApp(appId);
  if (!app) return null; // structurally shouldn't happen — evaluateAccessForLauncher already required an active app_registry row

  // EN-004 rule 12/AC8: a verified source mid-repair may show a neutral,
  // non-launchable card. Reads the column already fetched above — never
  // calls attemptLazyRepair, matching the deliberate "not called from the
  // learner-home route" decision entitlement-integrity's own lazy-repair
  // module already documents.
  if (row?.integrity_state === "repair_in_progress") {
    return {
      appId, appKey: app.appKey, appName: app.displayName, iconAssetKey: app.iconAssetKey, shortDescription: app.shortDescription,
      status: "restoring_access", progress: null, progressState: "summary_hidden_stale_or_blocked", lastUpdatedHint: false,
      session: { availableStandardSessions: 0, nearestStandardExpiryDate: null, technicalCreditsAvailable: 0, activeOrResumableSession: null },
      eligibility: { canStart: false, canResume: false, blockedReason: "restoring_access" },
      primaryAction: "none",
    };
  }

  const deployment = getPublishedDeployment(appId, environment, now);
  const deploymentBlocked = !deployment || deployment.dispatchBlocked || !deployment.compatibilityPassed;

  const summarySnapshot = readLearnerAppSummarySnapshot(learnerId, appId);
  const visibility = readProgressVisibilitySnapshot(learnerId, appId);
  const progress = visibility.readSafe && summarySnapshot.summary ? summarySnapshot.summary : null;
  const progressState = !visibility.readSafe ? "summary_hidden_stale_or_blocked"
    : summarySnapshot.summary ? "summary_available" : "learning_not_started";
  const lastUpdatedHint = visibility.readSafe && !!summarySnapshot.summary && summarySnapshot.visibilityStatus !== "current";

  const allowance = buildStandardAllowance(learnerId, appId, timezone, now);
  const technicalCreditsAvailable = technicalCreditsByApp.get(appId) ?? 0;

  const ownsActiveSession = activeSession?.app_id === appId;
  const activeOrResumableSession = ownsActiveSession && activeSession
    ? { learnerSessionId: activeSession.id, status: activeSession.status } : null;

  let blockedReason: LearnerHomeCardBlockedReason = null;
  let primaryAction: LearnerHomeCard["primaryAction"] = "none";
  let canStart = false; let canResume = false;

  if (deploymentBlocked) {
    blockedReason = "app_unavailable";
  } else if (activeSession && !ownsActiveSession) {
    blockedReason = "another_app_in_progress";
  } else if (ownsActiveSession && activeSession!.status === "starting") {
    blockedReason = "starting_reservation_in_progress";
  } else if (ownsActiveSession) {
    canResume = true; primaryAction = "resume";
  } else {
    const standardAvailable = allowance.availableCount > 0 && allowance.standardSessionsUsedThisWeek < allowance.standardWeeklyLimit;
    const hasCredit = standardAvailable || technicalCreditsAvailable > 0;
    if (!hasCredit) {
      blockedReason = allowance.standardSessionsUsedThisWeek >= allowance.standardWeeklyLimit ? "weekly_limit_reached" : "no_available_sessions";
    } else {
      canStart = true; primaryAction = "start";
    }
  }

  return {
    appId, appKey: app.appKey, appName: app.displayName, iconAssetKey: app.iconAssetKey, shortDescription: app.shortDescription,
    status: deploymentBlocked ? "temporarily_unavailable" : "active",
    progress, progressState, lastUpdatedHint,
    session: { availableStandardSessions: allowance.availableCount, nearestStandardExpiryDate: allowance.nearestExpiryDate,
      technicalCreditsAvailable, activeOrResumableSession },
    eligibility: { canStart, canResume, blockedReason },
    primaryAction,
  };
}

export function composeLearnerHome(learnerId: string, environment: string, now: Date): LearnerHomeResponse {
  const db = getDb();
  const appIds = (db.prepare(
    `select distinct app_id from learner_app_effective_entitlements where learner_id=? and environment=?`,
  ).all(learnerId, environment) as { app_id: string }[]).map((r) => r.app_id);

  const timezone = resolveParentTimezone(learnerId);

  // Called once per learner-home composition, not per app — both queries
  // already scope/return the learner's full app set, so scoping them
  // per-card would be a needless N+1 (rules 30-31, 43).
  const technicalCreditsByApp = new Map<string, number>();
  for (const credit of listTechnicalCredits({ actorType: "learner", actorId: learnerId }, learnerId, now)) {
    if (credit.status !== "available") continue;
    technicalCreditsByApp.set(credit.appId, (technicalCreditsByApp.get(credit.appId) ?? 0) + 1);
  }
  const activeSession = (db.prepare(
    `select id, app_id, status from learner_sessions where learner_id=? and status in ('starting','active','disconnected')
     order by started_at desc limit 1`,
  ).get(learnerId) as ActiveSession | undefined) ?? null;

  const cards: LearnerHomeCard[] = [];
  for (const appId of appIds) {
    try {
      const card = buildCard(learnerId, appId, environment, now, timezone, technicalCreditsByApp, activeSession);
      if (card) cards.push(card);
    } catch {
      cards.push(errorCard(appId));
    }
  }
  cards.sort((a, b) => a.appName.localeCompare(b.appName) || a.appId.localeCompare(b.appId));

  const versionInput = cards.map((c) => `${c.appId}:${c.status}:${c.primaryAction}:${c.session.availableStandardSessions}`).join("|")
    + `|session:${activeSession?.id ?? "none"}`;
  const launcherVersion = createHash("sha256").update(versionInput).digest("hex").slice(0, 16);

  return {
    learnerId, launcherVersion,
    activeSession: activeSession ? { appId: activeSession.app_id, learnerSessionId: activeSession.id, status: activeSession.status } : null,
    cards,
  };
}
