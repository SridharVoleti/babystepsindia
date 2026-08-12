"use client";

import { useEffect, useState } from "react";
import type { LearnerHomeCard, VersionedLearnerHomeResponse } from "@/lib/learner-home/contracts";
import type { AchievementView } from "@/lib/achievements/service";
import { createLauncherInvalidationMessage, fetchVersionedLearnerHome, isSafeLauncherInvalidationMessage,
  LAUNCHER_INVALIDATION_CHANNEL, LAUNCHER_INVALIDATION_EVENT, LauncherRefreshCoordinator,
  type LauncherRefreshSnapshot } from "@/lib/learner-home/refresh-controller";

const BLOCKED_REASON_TEXT: Record<string, string> = {
  another_app_in_progress: "Learning is already in progress in another app.",
  starting_reservation_in_progress: "Getting this app ready…",
  weekly_limit_reached: "This week's sessions are used up.",
  no_available_sessions: "No sessions available right now.",
  app_unavailable: "This app isn't available right now.",
  maintenance_starts_soon: "Maintenance starts soon. Start is paused so your full session can finish safely.",
  temporarily_unavailable: "This app is temporarily unavailable.",
  restoring_service: "Service is being restored. Start will return when it is safe.",
  security_blocked: "This app isn't available right now.",
  availability_unknown: "Availability could not be confirmed. Start is paused for safety.",
  restoring_access: "Restoring access — check back soon.",
};

function displayTime(value: string) {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}

function AvailabilityStatus({ card }: { card: LearnerHomeCard }) {
  const availability = card.operationalAvailability ?? { state: "unknown" as const, availabilityVersion: null,
    learnerMessage: null, nextMaintenanceStartAt: null, maintenanceEndsAt: null,
    safeStartUntil: null, expectedReturnAt: null, startBlocked: true };
  if (availability.state === "available") return null;
  const label = availability.state === "maintenance_soon"
    ? availability.startBlocked ? "Maintenance starts soon" : "Maintenance soon"
    : availability.state === "restoring" ? "Restoring service"
    : availability.state === "unknown" ? "Availability not confirmed"
    : "Temporarily unavailable";
  return <div className="mt-3 rounded-lg border border-chakra-200 bg-chakra-50 p-3 text-sm text-chakra-700"
    role="status" aria-label={`Operational availability: ${label}`}>
    <p className="font-medium">{label}</p>
    {availability.learnerMessage && <p className="mt-1">{availability.learnerMessage}</p>}
    {availability.nextMaintenanceStartAt && <p className="mt-1">Starts: {displayTime(availability.nextMaintenanceStartAt)}</p>}
    {availability.expectedReturnAt && <p className="mt-1">Expected return: {displayTime(availability.expectedReturnAt)}</p>}
  </div>;
}

function statusBadge(card: LearnerHomeCard) {
  if (card.status === "restoring_access") return <span>Restoring access</span>;
  if (card.status === "temporarily_unavailable") return <span>Temporarily unavailable</span>;
  if (card.primaryAction === "resume") return <span>In progress</span>;
  if (card.primaryAction === "start") return <span>Ready</span>;
  return <span>Not available</span>;
}

function Card({ card, actionsDisabled, onPrimaryAction }: {
  card: LearnerHomeCard;
  actionsDisabled: boolean;
  onPrimaryAction?: (card: LearnerHomeCard) => void;
}) {
  const blockedText = card.eligibility.blockedReason ? BLOCKED_REASON_TEXT[card.eligibility.blockedReason] : null;
  const actionable = card.primaryAction !== "none" && !!onPrimaryAction;
  return (
    <article className="card flex h-full flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-semibold text-chakra-900">{card.appName}</h2>
        <span className="text-sm text-chakra-600">{statusBadge(card)}</span>
      </div>
      <AvailabilityStatus card={card} />
      {blockedText && <p className="mt-1 text-sm text-chakra-600">{blockedText}</p>}
      <button type="button" className="btn-primary mt-4 min-h-[44px]" disabled={actionsDisabled || !actionable}
        onClick={() => onPrimaryAction?.(card)}>
        {card.primaryAction === "resume" ? "Resume" : "Start"}
      </button>
      <div className="mt-4 text-sm text-chakra-600">
        {card.progressState === "summary_available" && card.progress ? <>
          <p>Level: {card.progress.currentLevel}</p>
          {card.lastUpdatedHint && <p className="mt-1 text-xs text-chakra-400">Progress shown may be a little out of date.</p>}
        </> : card.progressState === "learning_not_started" ?
          <p>Learning hasn&apos;t started yet.</p> : <p>Progress details aren&apos;t available right now.</p>}
      </div>
      <details className="mt-3 text-sm text-chakra-500">
        <summary className="min-h-[44px] cursor-pointer py-3">More details</summary>
        <div className="space-y-1">
          {card.progress?.milestone && <p>Milestone: {card.progress.milestone}</p>}
          {card.progress && <p>Next: {card.progress.nextDestination}</p>}
          <p>Sessions available: {card.session.availableStandardSessions}</p>
          {card.session.nearestStandardExpiryDate && <p>Next expiry: {card.session.nearestStandardExpiryDate.slice(0, 10)}</p>}
        </div>
      </details>
    </article>
  );
}

function freshnessLabel(snapshot: LauncherRefreshSnapshot) {
  if (snapshot.status === "initializing") return "Loading your learning apps…";
  if (snapshot.status === "updating") return "Updating learning apps…";
  if (snapshot.status === "offline") return "Offline — Start and Resume are unavailable.";
  if (snapshot.status === "stale") return "Could not refresh. Showing the last safe update.";
  if (snapshot.status === "unavailable") return "Learning apps are unavailable right now.";
  return "Learning apps are up to date.";
}

function RecentAchievements({ achievements }: { achievements: AchievementView[] }) {
  if (achievements.length === 0) return null;
  return <section className="card mt-6 p-5" aria-labelledby="recent-achievements-title">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="recent-achievements-title" className="text-lg font-semibold text-chakra-900">Recent achievements</h2>
      <a href="/learner/achievements" className="inline-flex min-h-[44px] items-center font-medium text-green-700">
        View all achievements
      </a>
    </div>
    <ul className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
      {achievements.map((achievement) => <li key={achievement.achievementId}
        className="rounded-lg border border-chakra-100 bg-chakra-50 p-4">
        <div className="flex items-start gap-3">
          <span aria-hidden="true" className="text-2xl">&#9733;</span>
          <div>
            <p className="font-semibold text-chakra-900">{achievement.title}</p>
            <p className="mt-1 text-sm text-chakra-600">{achievement.appName}</p>
            <p className="mt-1 text-xs text-chakra-500">Earned {new Date(achievement.earnedAt).toLocaleDateString()}</p>
          </div>
        </div>
      </li>)}
    </ul>
  </section>;
}

export function LearnerLauncher({ learnerName, learnerId, contextVersion, contextBinding, initialData,
  onPrimaryAction }: {
  learnerName: string;
  learnerId: string;
  contextVersion: number;
  contextBinding: string;
  initialData: VersionedLearnerHomeResponse;
  onPrimaryAction?: (card: LearnerHomeCard) => void;
}) {
  const [coordinator, setCoordinator] = useState<LauncherRefreshCoordinator | null>(null);
  const [snapshot, setSnapshot] = useState<LauncherRefreshSnapshot>({ data: initialData, status: "stale",
    actionsDisabled: true, lastUpdatedAt: initialData.composedAt, errorMessage: null });

  useEffect(() => {
    let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;
    let storage: Storage | undefined;
    try { storage = window.sessionStorage; } catch { storage = undefined; }
    const instance = new LauncherRefreshCoordinator({ contextBinding, learnerId, contextVersion, initialData,
      fetchLauncher: fetchVersionedLearnerHome, storage,
      onAuthorizationLost: () => window.location.assign("/login"),
      onContextStale: () => window.location.assign("/"),
    });
    setCoordinator(instance);
    setSnapshot(instance.getSnapshot());
    const unsubscribe = instance.subscribe(() => setSnapshot(instance.getSnapshot()));
    void instance.refresh("page_entry");

    const visibility = () => {
      if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
      const duration = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      instance.visibilityReturned(duration);
    };
    const focus = () => { if (hiddenAt !== null) instance.visibilityReturned(Date.now() - hiddenAt); };
    const pageshow = (event: PageTransitionEvent) => instance.pageshow(event.persisted);
    const online = () => instance.online();
    const invalidation = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (isSafeLauncherInvalidationMessage(detail)) { instance.receiveInvalidation(detail); return; }
      const legacy = detail as { reason?: unknown; sessionVersion?: unknown } | null;
      if (legacy && ["resume_later", "finish_now"].includes(String(legacy.reason))
        && Number.isInteger(legacy.sessionVersion)) {
        instance.receiveInvalidation(createLauncherInvalidationMessage({ contextGeneration: contextVersion,
          reason: "acknowledged_action", sourceVersion: `session:${legacy.sessionVersion}` }));
      }
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    window.addEventListener("pageshow", pageshow);
    window.addEventListener("online", online);
    window.addEventListener(LAUNCHER_INVALIDATION_EVENT, invalidation);
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(LAUNCHER_INVALIDATION_CHANNEL);
      channel.onmessage = (event) => invalidation(new CustomEvent(LAUNCHER_INVALIDATION_EVENT, { detail: event.data }));
    }
    return () => {
      unsubscribe();
      instance.destroy();
      channel?.close();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
      window.removeEventListener("pageshow", pageshow);
      window.removeEventListener("online", online);
      window.removeEventListener(LAUNCHER_INVALIDATION_EVENT, invalidation);
    };
  }, [contextBinding, contextVersion, initialData, learnerId]);

  const cards = snapshot.data?.cards ?? [];
  const recentAchievements = snapshot.data?.recentAchievements ?? [];
  const showRefresh = ["stale", "offline", "unavailable"].includes(snapshot.status);
  return <>
    <div className="mt-6 flex min-h-[44px] flex-wrap items-center justify-between gap-3" aria-live="polite">
      <p className="text-sm text-chakra-600">{freshnessLabel(snapshot)}</p>
      {showRefresh && <button type="button" className="btn-secondary min-h-[44px] min-w-[44px]"
        disabled={!coordinator || snapshot.status === "updating"} onClick={() => void coordinator?.manualRefresh()}
        aria-label={snapshot.status === "unavailable" ? "Retry loading learning apps" : "Refresh learning apps"}>
        {snapshot.status === "unavailable" ? "Retry" : "Refresh"}
      </button>}
    </div>
    {snapshot.errorMessage && <p role="alert" className="mt-2 text-sm text-red-700">{snapshot.errorMessage}</p>}
    <p className="mt-8 text-sm font-medium text-chakra-500">Ready to learn</p>
    <h1 className="mt-1 text-3xl font-bold text-chakra-900">Hi, {learnerName}</h1>
    <RecentAchievements achievements={recentAchievements} />
    {!snapshot.data && snapshot.status === "initializing" ? <section className="card mt-6 p-6" aria-busy="true">
      <p>Loading your learning apps…</p>
    </section> : cards.length === 0 ? <section className="card mt-6 p-6">
      <h2 className="text-lg font-semibold text-chakra-900">Your learning apps</h2>
      <p className="mt-2 text-sm text-chakra-500">No apps are available to learn with right now.</p>
    </section> : <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => <Card key={card.appId} card={card} actionsDisabled={snapshot.actionsDisabled}
        onPrimaryAction={onPrimaryAction} />)}
    </div>}
  </>;
}
