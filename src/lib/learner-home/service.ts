import { createHash } from "node:crypto";
import { listRecentAchievements } from "@/lib/achievements/service";
import { readCurrentConsistency } from "@/lib/consistency/service";
import { resolveDbClient } from "@/lib/db-client";
import { evaluateAccessFresh } from "@/lib/entitlement-access/service";
import { getApp } from "@/lib/db/app-registry-repo";
import { getPublishedDeployment } from "@/lib/deployment-production/service";
import { buildStandardAllowance } from "@/lib/session-credit-standard/service";
import { listTechnicalCredits } from "@/lib/session-credit/service";
import { getParentTimezone } from "@/lib/db/learner-repo";
import { readLearnerAppSummarySnapshot } from "@/lib/app-progress/summary-read";
import { readProgressVisibilitySnapshot } from "@/lib/progress-integrity/service";
import { isoWeekKey } from "@/lib/learning-session/week";
import { readAppAvailability } from "@/lib/app-availability/service";
import type { LearnerHomeCard, LearnerHomeCardBlockedReason, LearnerHomeResponse } from "./contracts";

const LAUNCHER_CACHE_MAX_AGE_SECONDS = 60;

type ActiveSession = {
  id: string;
  app_id: string;
  status: "starting" | "active" | "disconnected" | "resumable";
  version: number;
  hard_expires_at: string | null;
  reservation_expires_at: string | null;
};

async function resolveParentTimezone(learnerId: string): Promise<string> {
  const learner = await resolveDbClient().get<{ owner_parent_id: string }>(
    "select owner_parent_id from learners where id=?", [learnerId]);
  return learner ? getParentTimezone(learner.owner_parent_id) : "Asia/Kolkata";
}

function errorCard(appId: string): LearnerHomeCard {
  return {
    appId, appKey: appId, appName: "Unavailable", iconAssetKey: null, shortDescription: null,
    status: "error", progress: null, progressState: "summary_hidden_stale_or_blocked", lastUpdatedHint: false,
    operationalAvailability: { state: "unknown", availabilityVersion: null, learnerMessage: null,
      nextMaintenanceStartAt: null, maintenanceEndsAt: null, safeStartUntil: null,
      expectedReturnAt: null, startBlocked: true },
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
async function buildCard(
  learnerId: string, appId: string, environment: string, now: Date,
  timezone: string, technicalCreditsByApp: Map<string, number>, activeSession: ActiveSession | null,
): Promise<LearnerHomeCard | null> {
  // UL-003 initial/conditional composition is authoritative. The derived
  // response may be cached by the exact learner context, but composition
  // itself never treats the display cache as access authority.
  const decision = evaluateAccessFresh({ learnerId, appId, environment, useCase: "launcher", now });
  if (!decision.allowed || (decision.state !== "active" && decision.state !== "grace")) return null;

  const row = await resolveDbClient().get<{ integrity_state: string }>(
    `select integrity_state from learner_app_effective_entitlements where learner_id=? and app_id=? and environment=?`,
    [learnerId, appId, environment]);

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
      operationalAvailability: { state: "unknown", availabilityVersion: null, learnerMessage: null,
        nextMaintenanceStartAt: null, maintenanceEndsAt: null, safeStartUntil: null,
        expectedReturnAt: null, startBlocked: true },
      session: { availableStandardSessions: 0, nearestStandardExpiryDate: null, technicalCreditsAvailable: 0, activeOrResumableSession: null },
      eligibility: { canStart: false, canResume: false, blockedReason: "restoring_access" },
      primaryAction: "none",
    };
  }

  const deployment = getPublishedDeployment(appId, environment, now);
  const deploymentBlocked = !deployment || deployment.dispatchBlocked || !deployment.compatibilityPassed;

  let availability: NonNullable<LearnerHomeCard["operationalAvailability"]>;
  try {
    const operational = readAppAvailability(appId, environment, now);
    availability = { state: operational.operationalAvailability,
      availabilityVersion: operational.availabilityVersion, learnerMessage: operational.learnerMessage,
      nextMaintenanceStartAt: operational.nextMaintenanceStartAt,
      maintenanceEndsAt: operational.maintenanceEndsAt, safeStartUntil: operational.safeStartUntil,
      expectedReturnAt: operational.expectedReturnAt, startBlocked: operational.startBlocked };
  } catch {
    availability = { state: "unknown", availabilityVersion: null, learnerMessage: null,
      nextMaintenanceStartAt: null, maintenanceEndsAt: null, safeStartUntil: null,
      expectedReturnAt: null, startBlocked: true };
  }

  const summarySnapshot = await readLearnerAppSummarySnapshot(learnerId, appId);
  const visibility = readProgressVisibilitySnapshot(learnerId, appId);
  const progress = visibility.readSafe && summarySnapshot.summary ? summarySnapshot.summary : null;
  const progressState = !visibility.readSafe ? "summary_hidden_stale_or_blocked"
    : summarySnapshot.summary ? "summary_available" : "learning_not_started";
  const lastUpdatedHint = visibility.readSafe && !!summarySnapshot.summary && summarySnapshot.visibilityStatus !== "current";

  const allowance = buildStandardAllowance(learnerId, appId, timezone, now);
  const consistency = readCurrentConsistency(learnerId, appId, environment, now);
  const technicalCreditsAvailable = technicalCreditsByApp.get(appId) ?? 0;

  const ownsActiveSession = activeSession?.app_id === appId;
  const activeOrResumableSession = ownsActiveSession && activeSession
    ? { learnerSessionId: activeSession.id, status: activeSession.status } : null;

  let blockedReason: LearnerHomeCardBlockedReason = null;
  let primaryAction: LearnerHomeCard["primaryAction"] = "none";
  let canStart = false; let canResume = false;

  if (deploymentBlocked) {
    blockedReason = "app_unavailable";
  } else if (availability.state === "security_blocked") {
    blockedReason = "security_blocked";
  } else if (activeSession && !ownsActiveSession) {
    blockedReason = "another_app_in_progress";
  } else if (ownsActiveSession && activeSession!.status === "starting") {
    blockedReason = "starting_reservation_in_progress";
  } else if (ownsActiveSession) {
    canResume = true; primaryAction = "resume";
  } else if (availability.startBlocked) {
    blockedReason = availability.state === "maintenance_soon" ? "maintenance_starts_soon"
      : availability.state === "restoring" ? "restoring_service"
      : availability.state === "unknown" ? "availability_unknown"
      : "temporarily_unavailable";
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
    status: deploymentBlocked || availability.startBlocked ? "temporarily_unavailable" : "active",
    progress, progressState, consistency, lastUpdatedHint, operationalAvailability: availability,
    session: { availableStandardSessions: allowance.availableCount, nearestStandardExpiryDate: allowance.nearestExpiryDate,
      technicalCreditsAvailable, activeOrResumableSession },
    eligibility: { canStart, canResume, blockedReason },
    primaryAction,
  };
}

function nextWeekBoundary(now: Date, timezone: string) {
  const currentWeek = isoWeekKey(now, timezone);
  let low = now.getTime();
  let high = low + 8 * 24 * 60 * 60 * 1000;
  if (isoWeekKey(new Date(high), timezone) === currentWeek) return null;
  while (high - low > 1000) {
    const mid = Math.floor((low + high) / 2);
    if (isoWeekKey(new Date(mid), timezone) === currentWeek) low = mid;
    else high = mid;
  }
  return new Date(high).toISOString();
}

async function earliestFutureBoundary(input: {
  learnerId: string;
  environment: string;
  appIds: string[];
  activeSession: ActiveSession | null;
  cards: LearnerHomeCard[];
  timezone: string;
  now: Date;
}) {
  const candidates: string[] = [];
  const add = (value: string | null | undefined) => {
    if (value && new Date(value).getTime() > input.now.getTime()) candidates.push(new Date(value).toISOString());
  };
  add(input.activeSession?.hard_expires_at);
  add(input.activeSession?.reservation_expires_at);

  const db = resolveDbClient();
  for (const row of await db.all<{ access_until: string }>(`select access_until from learner_app_effective_entitlements
    where learner_id=? and environment=? and access_until is not null`, [input.learnerId, input.environment])) add(row.access_until);
  for (const row of await db.all<{ expires_at: string }>(`select expires_at from learner_app_standard_credit_batches
    where learner_id=? and granted_count-reserved_count-consumed_count>0 and expires_at>?`, [
      input.learnerId, input.now.toISOString()])) add(row.expires_at);

  if (input.appIds.length > 0) {
    const placeholders = input.appIds.map(() => "?").join(",");
    const windows = await db.all<{ starts_at: string; ends_at: string; drain_starts_at: string }>(
      `select starts_at,ends_at,drain_starts_at from app_deployment_windows
      where app_id in (${placeholders}) and status in ('scheduled','draining','executing','extended_safe_block')`,
      input.appIds);
    for (const window of windows) { add(window.drain_starts_at); add(window.starts_at); add(window.ends_at); }
    const availabilityWindows = await db.all<{ starts_at: string; ends_at: string }>(
      `select starts_at,ends_at from app_maintenance_windows
      where app_id in (${placeholders}) and environment=? and status='scheduled' and ends_at>?`,
      [...input.appIds, input.environment, input.now.toISOString()]);
    for (const window of availabilityWindows) {
      add(new Date(new Date(window.starts_at).getTime() - 3_900_000).toISOString());
      add(window.starts_at); add(window.ends_at);
    }
  }
  if (input.cards.some((card) => card.eligibility.blockedReason === "weekly_limit_reached")) {
    add(nextWeekBoundary(input.now, input.timezone));
  }
  return candidates.sort()[0] ?? null;
}

export async function computeLauncherSourceVersionHash(learnerId: string, environment: string) {
  const db = resolveDbClient();
  const invalidationRow = await db.get<{ invalidation_version: number }>(`select invalidation_version
    from launcher_freshness_metadata where learner_id=? and environment=?`, [learnerId, environment]);
  const sources = {
    entitlements: await db.all(`select app_id,state,access_until,effective_version,source_set_hash,integrity_state,
      lifecycle_version,scheduled_transition_at,revoked_before from learner_app_effective_entitlements
      where learner_id=? and environment=? order by app_id`, [learnerId, environment]),
    progress: await db.all(`select app_id,progress_version,progress_summary_visibility_status,
      progress_summary_based_on_version,progress_summary_version,progress_summary_state_hash,updated_at
      from learner_app_progress where learner_id=? order by app_id`, [learnerId]),
    credits: await db.all(`select app_id,expires_at,granted_count,reserved_count,consumed_count,version
      from learner_app_standard_credit_batches where learner_id=? order by app_id,expires_at,id`, [learnerId]),
    sessions: await db.all(`select id,app_id,status,version,hard_expires_at,reservation_expires_at,exit_transition_version
      from learner_sessions where learner_id=? and status in ('starting','active','disconnected','resumable') order by id`,
      [learnerId]),
    publications: await db.all(`select p.app_id,p.current_published_deployment_id,p.version
      from app_environment_publications p join learner_app_effective_entitlements e on e.app_id=p.app_id
      and e.learner_id=? and e.environment=p.environment where p.environment=? order by p.app_id`,
      [learnerId, environment]),
    availability: await db.all(`select a.app_id,a.operational_state,a.availability_version,a.expected_return_at,a.updated_at
      from app_launch_availability a join learner_app_effective_entitlements e on e.app_id=a.app_id
      and e.learner_id=? and e.environment=a.environment where a.environment=? order by a.app_id`,
      [learnerId, environment]),
    maintenanceWindows: await db.all(`select w.app_id,w.starts_at,w.ends_at,w.status,w.window_version
      from app_maintenance_windows w join learner_app_effective_entitlements e on e.app_id=w.app_id
      and e.learner_id=? and e.environment=w.environment where w.environment=? and w.status='scheduled'
      order by w.app_id,w.starts_at,w.id`, [learnerId, environment]),
    achievements: await db.all(`select id,app_id,earned_at,record_version,revoked_at
      from learner_achievements where learner_id=? order by earned_at desc,id desc limit 20`, [learnerId]),
    consistency: await db.all(`select app_id,current_streak_weeks,longest_streak_weeks,current_week_key,
      current_week_progress,state_version,state_hash from learner_app_consistency
      where learner_id=? and environment=? order by app_id`, [learnerId, environment]),
    invalidationVersion: invalidationRow?.invalidation_version ?? 0,
  };
  return createHash("sha256").update(JSON.stringify(sources)).digest("hex");
}

export async function composeLearnerHome(learnerId: string, environment: string, now: Date,
  selectedLearnerContextVersion = 0): Promise<LearnerHomeResponse> {
  const db = resolveDbClient();
  const appIds = (await db.all<{ app_id: string }>(
    `select distinct app_id from learner_app_effective_entitlements where learner_id=? and environment=?`,
    [learnerId, environment])).map((r) => r.app_id);

  const timezone = await resolveParentTimezone(learnerId);

  // Called once per learner-home composition, not per app — both queries
  // already scope/return the learner's full app set, so scoping them
  // per-card would be a needless N+1 (rules 30-31, 43).
  const technicalCreditsByApp = new Map<string, number>();
  for (const credit of listTechnicalCredits({ actorType: "learner", actorId: learnerId }, learnerId, now)) {
    if (credit.status !== "available") continue;
    technicalCreditsByApp.set(credit.appId, (technicalCreditsByApp.get(credit.appId) ?? 0) + 1);
  }
  const activeSession = (await db.get<ActiveSession>(
    `select id,app_id,status,version,hard_expires_at,reservation_expires_at from learner_sessions
     where learner_id=? and status in ('starting','active','disconnected','resumable')
     order by started_at desc limit 1`,
    [learnerId])) ?? null;

  const cards: LearnerHomeCard[] = [];
  for (const appId of appIds) {
    try {
      const card = await buildCard(learnerId, appId, environment, now, timezone, technicalCreditsByApp, activeSession);
      if (card) cards.push(card);
    } catch {
      cards.push(errorCard(appId));
    }
  }
  cards.sort((a, b) => a.appName.localeCompare(b.appName) || a.appId.localeCompare(b.appId));

  const composedAt = now.toISOString();
  const nextRecheckAt = await earliestFutureBoundary({ learnerId, environment, appIds, activeSession, cards, timezone, now });
  const sourceVersionHash = await computeLauncherSourceVersionHash(learnerId, environment);
  const recentAchievements = await listRecentAchievements(learnerId, 3);
  const versionInput = JSON.stringify({ learnerId, environment, selectedLearnerContextVersion,
    sourceVersionHash, cards, recentAchievements, activeSession: activeSession ? { id: activeSession.id, appId: activeSession.app_id,
      status: activeSession.status, version: activeSession.version, hardExpiresAt: activeSession.hard_expires_at,
      reservationExpiresAt: activeSession.reservation_expires_at } : null, nextRecheckAt });
  const launcherVersion = createHash("sha256").update(versionInput).digest("hex").slice(0, 32);

  return {
    learnerId, launcherVersion, serverTime: composedAt, composedAt, nextRecheckAt,
    cacheMaxAgeSeconds: LAUNCHER_CACHE_MAX_AGE_SECONDS, selectedLearnerContextVersion,
    activeSession: activeSession ? { appId: activeSession.app_id, learnerSessionId: activeSession.id, status: activeSession.status } : null,
    recentAchievements,
    cards,
  };
}
