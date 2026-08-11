import type { Metadata } from "next";
import { requireLearnerMode } from "@/lib/auth/guards";
import { getOwnedLearner, getParentTimezone } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { composeLearnerHome } from "@/lib/learner-home/service";
import type { LearnerHomeCard } from "@/lib/learner-home/contracts";
import { LearnerModeExitForm } from "@/components/learner-mode/exit-form";

export const metadata: Metadata = { title: "Learning mode — Baby Steps" };

const BLOCKED_REASON_TEXT: Record<string, string> = {
  another_app_in_progress: "Learning is already in progress in another app.",
  starting_reservation_in_progress: "Getting this app ready…",
  weekly_limit_reached: "This week's sessions are used up.",
  no_available_sessions: "No sessions available right now.",
  app_unavailable: "This app isn't available right now.",
  restoring_access: "Restoring access — check back soon.",
};

function statusBadge(card: LearnerHomeCard) {
  if (card.status === "restoring_access") return <span aria-hidden className="text-saffron-700">⟳ Restoring access</span>;
  if (card.status === "temporarily_unavailable") return <span aria-hidden className="text-saffron-700">⚠ Temporarily unavailable</span>;
  if (card.primaryAction === "resume") return <span aria-hidden className="text-green-700">▶ In progress</span>;
  if (card.primaryAction === "start") return <span aria-hidden className="text-green-700">● Ready</span>;
  return <span aria-hidden className="text-chakra-500">○ Not available</span>;
}

function LearnerHomeCardView({ card }: { card: LearnerHomeCard }) {
  const blockedText = card.eligibility.blockedReason ? BLOCKED_REASON_TEXT[card.eligibility.blockedReason] : null;
  return (
    <article className="card flex h-full flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-semibold text-chakra-900">{card.appName}</h2>
        {statusBadge(card)}
      </div>
      {blockedText && <p className="mt-1 text-sm text-chakra-600">{blockedText}</p>}
      <button type="button" className="btn-primary mt-4 min-h-[44px]" disabled title="Starting a session isn't available in this build yet">
        {card.primaryAction === "resume" ? "Resume" : "Start"}
      </button>
      <div className="mt-4 text-sm text-chakra-600">
        {card.progressState === "summary_available" && card.progress ? (
          <>
            <p>Level: {card.progress.currentLevel}</p>
            {card.lastUpdatedHint && <p className="mt-1 text-xs text-chakra-400">Progress shown may be a little out of date.</p>}
          </>
        ) : card.progressState === "learning_not_started" ? (
          <p>Learning hasn&apos;t started yet.</p>
        ) : (
          <p>Progress details aren&apos;t available right now.</p>
        )}
      </div>
      <details className="mt-3 text-sm text-chakra-500">
        <summary className="cursor-pointer">More details</summary>
        <div className="mt-2 space-y-1">
          {card.progress?.milestone && <p>Milestone: {card.progress.milestone}</p>}
          {card.progress && <p>Next: {card.progress.nextDestination}</p>}
          <p>Sessions available: {card.session.availableStandardSessions}</p>
          {card.session.nearestStandardExpiryDate && <p>Next expiry: {card.session.nearestStandardExpiryDate.slice(0, 10)}</p>}
        </div>
      </details>
    </article>
  );
}

export default async function LearnerPage() {
  const { session, authorization } = await requireLearnerMode();
  const learner = getOwnedLearner(session.sub, authorization.learnerId!,
    calendarDateInTimeZone(getParentTimezone(session.sub)));
  const home = composeLearnerHome(authorization.learnerId!, "production", new Date());

  return (
    <div className="min-h-screen bg-chakra-50">
      <header className="border-b border-chakra-100 bg-white px-6 py-4">
        <p className="text-sm font-semibold text-green-700">Baby Steps learning mode</p>
      </header>
      <main className="mx-auto w-full max-w-4xl px-6 py-12">
        <p className="text-sm font-medium text-chakra-500">Ready to learn</p>
        <h1 className="mt-1 text-3xl font-bold text-chakra-900">Hi, {learner.displayName}</h1>
        {home.cards.length === 0 ? (
          <section className="card mt-6 p-6">
            <h2 className="text-lg font-semibold text-chakra-900">Your learning apps</h2>
            <p className="mt-2 text-sm text-chakra-500">No apps are available to learn with right now.</p>
          </section>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {home.cards.map((card) => <LearnerHomeCardView key={card.appId} card={card} />)}
          </div>
        )}
        <LearnerModeExitForm />
      </main>
    </div>
  );
}
