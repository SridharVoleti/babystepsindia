import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireParentManagement } from "@/lib/auth/guards";
import { getOwnedLearner, getParentTimezone } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { JourneyError, listJourney } from "@/lib/journey/service";
import { JourneyTimeline } from "@/components/journey/journey-timeline";

export const metadata: Metadata = { title: "Learner journey — Baby Steps" };

export default async function ParentJourneyPage({ params }: { params: { learnerId: string; appId: string } }) {
  const { session } = await requireParentManagement();
  const learner = await getOwnedLearner(session.sub, params.learnerId,
    calendarDateInTimeZone(await getParentTimezone(session.sub)));
  let page;
  try { page = listJourney({ learnerId: params.learnerId, appId: params.appId, limit: 50,
    exposeRetentionDeadline: true }); }
  catch (error) {
    if (error instanceof JourneyError && ["JOURNEY_NOT_FOUND", "JOURNEY_PURGED"].includes(error.code)) notFound();
    throw error;
  }
  return <main className="mx-auto w-full max-w-3xl px-6 py-12">
    <a href={`/account/learners/${params.learnerId}/apps`} className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700">Back to apps</a>
    <p className="mt-5 text-sm font-semibold text-green-700">{learner.displayName}&apos;s journey</p>
    <h1 className="mt-1 text-3xl font-bold text-chakra-900">{page.appName}</h1>
    <p className="mt-2 text-chakra-600">Completed lessons, achievements, and meaningful milestones in date order.</p>
    <JourneyTimeline initialPage={page} endpoint={`/v1/parent/learners/${params.learnerId}/apps/${params.appId}/journey`} />
  </main>;
}

