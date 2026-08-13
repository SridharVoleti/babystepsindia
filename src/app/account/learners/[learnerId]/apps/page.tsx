import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireParentManagement } from "@/lib/auth/guards";
import { getOwnedLearner, getParentTimezone, LearnerCreationError } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { composeLearnerHome } from "@/lib/learner-home/service";
import { listPastApps } from "@/lib/learner-home/past-apps";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { SubscribeAgainButton } from "@/components/learner-home/subscribe-again-button";
import { MotivationProgressView } from "@/components/progress/motivation-progress";

export const metadata: Metadata = { title: "Learner apps — Baby Steps" };

export default async function LearnerAppsPage({ params }: { params: { learnerId: string } }) {
  const { session } = await requireParentManagement();
  let learner;
  try {
    learner = getOwnedLearner(session.sub, params.learnerId,
      calendarDateInTimeZone(getParentTimezone(session.sub)));
  } catch (error) {
    if (error instanceof LearnerCreationError && error.code === "LEARNER_NOT_FOUND") notFound();
    throw error;
  }
  const home = composeLearnerHome(params.learnerId, "production", new Date());
  const pastApps = listPastApps(session.sub, params.learnerId, new Date());

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
        <Link href="/account" className="text-sm font-medium text-green-700">← Back to account</Link>
        <h1 className="mt-3 text-2xl font-bold text-chakra-900">{learner.displayName}&apos;s apps</h1>

        <section className="mt-6">
          <h2 className="text-lg font-semibold text-chakra-900">Current apps</h2>
          {home.cards.length === 0 ? (
            <p className="card mt-3 p-5 text-sm text-chakra-500">No current apps.</p>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {home.cards.map((card) => (
                <article key={card.appId} className="card p-4">
                  <h3 className="font-semibold text-chakra-900">{card.appName}</h3>
                  <p className="mt-1 text-sm text-chakra-500">{card.status === "active" ? "Active" :
                    card.status === "restoring_access" ? "Restoring access" : "Temporarily unavailable"}</p>
                  {card.progress && <MotivationProgressView progress={card.progress.motivationProgress} className="mt-3" />}
                  <Link href={`/account/learners/${params.learnerId}/apps/${card.appId}/journey`}
                    className="mt-3 inline-flex min-h-[44px] items-center text-sm font-medium text-green-700">View journey</Link>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="mt-8">
          <h2 className="text-lg font-semibold text-chakra-900">Past apps</h2>
          {pastApps.length === 0 ? (
            <p className="card mt-3 p-5 text-sm text-chakra-500">No past apps.</p>
          ) : (
            <div className="mt-3 space-y-3">
              {pastApps.map((app) => (
                <article key={app.appId} className="card flex items-center justify-between gap-4 p-4">
                  <div>
                    <h3 className="font-semibold text-chakra-900">{app.appName}</h3>
                    {app.accessEndedDate && <p className="mt-1 text-sm text-chakra-500">
                      Access ended {app.accessEndedDate.slice(0, 10)}</p>}
                    {app.lastSafeSummary ? (
                      <>
                        <p className="mt-1 text-sm text-chakra-500">Last level: {app.lastSafeSummary.currentLevel}</p>
                        <MotivationProgressView progress={app.lastSafeSummary.motivationProgress} className="mt-3" />
                      </>
                    ) : (
                      <p className="mt-1 text-sm text-chakra-500">Preserved progress unavailable.</p>
                    )}
                  </div>
                  {app.subscribeAgain.offered ?
                    <SubscribeAgainButton learnerId={params.learnerId} appId={app.appId} /> :
                    <p className="text-xs text-chakra-400">Not currently available to subscribe.</p>}
                  <Link href={`/account/learners/${params.learnerId}/apps/${app.appId}/journey`}
                    className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700">View journey</Link>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
