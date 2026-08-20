import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireParentManagement } from "@/lib/auth/guards";
import { composeParentLearnerDetail, composeParentAppDetail, ParentLearnerDetailError } from "@/lib/parent-learner-detail/service";
import { SubscribeAgainButton } from "@/components/learner-home/subscribe-again-button";
import { MotivationProgressView } from "@/components/progress/motivation-progress";

export const metadata: Metadata = { title: "Learner apps — Baby Steps" };

function tabClass(active: boolean) {
  return `inline-flex min-h-[44px] items-center rounded-lg px-4 py-2 text-sm font-medium ${
    active ? "bg-green-700 text-white" : "bg-chakra-100 text-chakra-700"}`;
}

function selectorClass(active: boolean) {
  return `inline-flex min-h-[44px] items-center rounded-lg border px-3 py-2 text-sm font-medium ${
    active ? "border-green-700 bg-green-50 text-green-800" : "border-chakra-200 text-chakra-700"}`;
}

export default async function LearnerAppsPage({ params, searchParams }: {
  params: { learnerId: string };
  searchParams: { tab?: string; app?: string };
}) {
  const { session } = await requireParentManagement();
  let detail;
  try {
    detail = await composeParentLearnerDetail(session.sub, params.learnerId, new Date());
  } catch (error) {
    if (error instanceof ParentLearnerDetailError && error.code === "RESOURCE_NOT_FOUND") notFound();
    throw error;
  }

  const tab: "current" | "past" = searchParams.tab === "past" ? "past" : "current";
  const list = tab === "current" ? detail.current : detail.past;
  const selectedAppId = searchParams.app ?? list[0]?.appId ?? null;
  const selected = selectedAppId
    ? await composeParentAppDetail(session.sub, params.learnerId, selectedAppId, new Date())
    : null;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-16">
      <Link href="/account" className="text-sm font-medium text-green-700">← Back to dashboard</Link>
        <h1 className="mt-3 text-2xl font-bold text-chakra-900">{detail.displayName}&apos;s apps</h1>

        <div className="mt-4 flex gap-2">
          <Link href="?tab=current" className={tabClass(tab === "current")}>Current ({detail.current.length})</Link>
          <Link href="?tab=past" className={tabClass(tab === "past")}>Past ({detail.past.length})</Link>
        </div>

        {list.length === 0 ? (
          <p className="card mt-4 p-5 text-sm text-chakra-500">No {tab} apps.</p>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            {list.map((app) => (
              <Link key={app.appId} href={`?tab=${tab}&app=${app.appId}`} className={selectorClass(app.appId === selectedAppId)}>
                {app.appName}
              </Link>
            ))}
          </div>
        )}

        {selected && (
          <section className="card mt-6 p-5">
            <h2 className="text-lg font-semibold text-chakra-900">{selected.appName}</h2>

            {selected.current && (
              <>
                <p className="mt-2 text-sm text-chakra-600">
                  Level: {selected.current.progress?.currentLevel ?? "Not started"}
                  {selected.current.progress?.nextDestination ? ` → ${selected.current.progress.nextDestination}` : ""}
                </p>
                {/* PD2-G07: PR-003's completed-milestone field, shown only when supplied — never invented. */}
                {selected.current.progress?.milestone && (
                  <p className="mt-1 text-sm text-chakra-600">Milestone: {selected.current.progress.milestone}</p>
                )}
                {selected.current.consistency && (
                  <p className="mt-1 text-sm text-chakra-600">
                    This week: {selected.current.consistency.currentWeekProgress}/{selected.current.consistency.target} ·{" "}
                    Streak {selected.current.consistency.currentStreakWeeks}w
                    (longest {selected.current.consistency.longestStreakWeeks}w)
                  </p>
                )}
                {selected.current.progress && (
                  <MotivationProgressView progress={selected.current.progress.motivationProgress} className="mt-3" />
                )}
              </>
            )}

            {selected.past && (
              <>
                {selected.past.accessEndedDate && (
                  <p className="mt-2 text-sm text-chakra-500">Access ended {selected.past.accessEndedDate.slice(0, 10)}</p>
                )}
                {selected.past.lastSafeSummary ? (
                  <p className="mt-1 text-sm text-chakra-600">Last level: {selected.past.lastSafeSummary.currentLevel}</p>
                ) : (
                  <p className="mt-1 text-sm text-chakra-500">Preserved progress unavailable.</p>
                )}
                <p className="mt-1 text-sm text-chakra-600">
                  Streak history: {selected.past.consistency.lastCurrentStreakWeeks}w
                  (longest {selected.past.consistency.longestStreakWeeks}w)
                </p>
                {selected.past.subscribeAgain.offered ? (
                  <div className="mt-3"><SubscribeAgainButton learnerId={params.learnerId} appId={selected.appId} /></div>
                ) : (
                  <p className="mt-3 text-xs text-chakra-400">Not currently available to subscribe.</p>
                )}
              </>
            )}

            {selected.recentAchievements.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium uppercase tracking-wide text-chakra-400">Recent achievements</p>
                <ul className="mt-1 space-y-1">
                  {selected.recentAchievements.map((achievement) => (
                    <li key={achievement.achievementId} className="text-sm text-chakra-600">{achievement.title}</li>
                  ))}
                </ul>
              </div>
            )}

            {selected.attention.length > 0 && (
              <div className="mt-4 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
                {selected.attention.map((item) => (
                  <p key={item.sourceKey} className="text-sm text-amber-900">{item.title}</p>
                ))}
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-4">
              <Link href={selected.journeyHref}
                className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700 hover:text-green-800">
                View journey →
              </Link>
              <Link href={`/account/learners/${params.learnerId}/achievements`}
                className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700 hover:text-green-800">
                View all achievements →
              </Link>
            </div>
          </section>
        )}
    </main>
  );
}
