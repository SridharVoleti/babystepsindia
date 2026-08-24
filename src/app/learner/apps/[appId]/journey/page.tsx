import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireLearnerMode } from "@/lib/auth/guards";
import { evaluateAccessForLauncher } from "@/lib/entitlement-access/launcher-cache";
import { JourneyError, listJourney } from "@/lib/journey/service";
import { JourneyTimeline } from "@/components/journey/journey-timeline";

export const metadata: Metadata = { title: "My journey — Baby Steps" };

export default async function LearnerJourneyPage({ params }: { params: { appId: string } }) {
  const { authorization } = await requireLearnerMode();
  const learnerId = authorization.learnerId!;
  const access = await evaluateAccessForLauncher({ learnerId, appId: params.appId, environment: "production", now: new Date() });
  if (!access.allowed || !["active", "grace"].includes(access.state)) notFound();
  let page;
  try { page = await listJourney({ learnerId, appId: params.appId, limit: 50 }); }
  catch (error) {
    if (error instanceof JourneyError && ["JOURNEY_NOT_FOUND", "JOURNEY_PURGED"].includes(error.code)) notFound();
    throw error;
  }
  return <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-12">
    <a href="/learner" className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700">Back to learning apps</a>
    <p className="mt-5 text-sm font-semibold text-green-700">My journey</p>
    <h1 className="mt-1 text-3xl font-bold text-chakra-900">{page.appName}</h1>
    <p className="mt-2 text-chakra-600">Completed lessons, achievements, and meaningful milestones in date order.</p>
    <JourneyTimeline initialPage={page} endpoint={`/v1/learner-apps/${params.appId}/journey`} />
  </main>;
}

