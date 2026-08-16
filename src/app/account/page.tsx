import Link from "next/link";
import type { Metadata } from "next";
import { requireParentManagement } from "@/lib/auth/guards";
import { composeParentDashboard } from "@/lib/parent-dashboard/service";
import type { ParentDashboardAppCard, ParentDashboardLearnerCard } from "@/lib/parent-dashboard/service";
import { MotivationProgressView } from "@/components/progress/motivation-progress";

export const metadata: Metadata = { title: "Your dashboard — Baby Steps" };

const STATUS_LABEL: Record<ParentDashboardAppCard["status"], string> = {
  active: "Active",
  restoring_access: "Restoring access",
  temporarily_unavailable: "Temporarily unavailable",
  error: "Status unavailable",
};

function AppCard({ card }: { card: ParentDashboardAppCard }) {
  return (
    <article className="card p-4">
      <h4 className="break-words font-semibold text-chakra-900">{card.appName}</h4>
      <p className="mt-1 text-sm text-chakra-500">{STATUS_LABEL[card.status]}</p>
      {card.consistency && (
        <p className="mt-1 text-sm text-chakra-600">
          This week: {card.consistency.currentWeekProgress}/{card.consistency.target} ·
          {" "}Streak {card.consistency.currentStreakWeeks}w
        </p>
      )}
      {card.progress && (
        <>
          <p className="mt-1 text-sm text-chakra-600">
            Level: {card.progress.currentLevel}
            {card.progress.nextDestination ? ` → ${card.progress.nextDestination}` : ""}
          </p>
          <MotivationProgressView progress={card.progress.motivationProgress} className="mt-2" />
        </>
      )}
    </article>
  );
}

function LearnerSection({ learner }: { learner: ParentDashboardLearnerCard }) {
  return (
    <section className="card mt-6 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="break-words text-lg font-semibold text-chakra-900">{learner.displayName}</h2>
          {learner.appsOnTrack && (
            <p className="mt-1 text-sm text-chakra-500">
              Apps on track this week: {learner.appsOnTrack.completed}/{learner.appsOnTrack.total}
            </p>
          )}
        </div>
        <Link href={`/account/learners/${learner.learnerId}/unlock`}
          className="btn-primary inline-flex min-h-[44px] items-center">
          Open {learner.displayName}
        </Link>
      </div>

      {learner.attentionPreview.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm text-amber-900">
            {learner.attentionPreview.length} item{learner.attentionPreview.length === 1 ? "" : "s"} need attention.{" "}
            <Link href="/account/attention" className="inline-flex min-h-[44px] items-center font-medium underline">
              Review →
            </Link>
          </p>
        </div>
      )}

      {learner.currentApps.length === 0 ? (
        <p className="mt-4 text-sm text-chakra-500">No current apps yet.</p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {learner.currentApps.map((card) => <AppCard key={card.appId} card={card} />)}
        </div>
      )}

      <Link href={`/account/learners/${learner.learnerId}/apps`}
        className="mt-4 inline-flex min-h-[44px] items-center text-sm font-medium text-green-700 hover:text-green-800">
        View all apps →
      </Link>
    </section>
  );
}

export default async function AccountPage() {
  const { session } = await requireParentManagement();
  const dashboard = composeParentDashboard(session.sub, new Date());

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-16">
      <h1 className="text-2xl font-bold text-chakra-900">Your dashboard</h1>
      <p className="mt-1 text-sm text-chakra-500">{session.email}</p>

      {dashboard.learners.length === 0 ? (
        <div className="card mt-6 p-5">
          <p className="text-sm text-chakra-500">No learner profiles yet.</p>
        </div>
      ) : (
        dashboard.learners.map((learner) => <LearnerSection key={learner.learnerId} learner={learner} />)
      )}

      {Object.keys(dashboard.partialErrors).length > 0 && (
        <p className="mt-6 text-xs text-chakra-400">
          Some learners couldn&apos;t be loaded just now. Reload to try again.
        </p>
      )}
    </main>
  );
}
