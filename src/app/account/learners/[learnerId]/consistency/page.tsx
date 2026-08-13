import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireParentManagement } from "@/lib/auth/guards";
import { getOwnedLearner, getParentTimezone, LearnerCreationError } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { listConsistency } from "@/lib/consistency/service";
import { ConsistencyHistory } from "@/components/consistency/consistency-history";

export const metadata: Metadata = { title: "Learner weekly consistency — Baby Steps" };

export default async function ParentLearnerConsistencyPage({ params }: { params: { learnerId: string } }) {
  const { session } = await requireParentManagement();
  let learner;
  try {
    learner = getOwnedLearner(session.sub, params.learnerId,
      calendarDateInTimeZone(getParentTimezone(session.sub)));
  } catch (error) {
    if (error instanceof LearnerCreationError && error.code === "LEARNER_NOT_FOUND") notFound();
    throw error;
  }
  const page = listConsistency({ learnerId: params.learnerId, limit: 20 });
  return <main className="mx-auto w-full max-w-3xl px-6 py-12">
    <a href={`/account/learners/${params.learnerId}/progress`}
      className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700">Back to learner progress</a>
    <p className="mt-6 text-sm font-semibold text-green-700">Parent view</p>
    <h1 className="mt-1 text-3xl font-bold text-chakra-900">{learner.displayName}&apos;s weekly consistency</h1>
    <p className="mt-2 text-chakra-600">Each app is independent and reflects its normal two-session weekly cadence.</p>
    <ConsistencyHistory apps={page.apps} initialHistory={page.history} initialCursor={page.nextCursor}
      endpoint={`/v1/parent/learners/${params.learnerId}/consistency`} />
  </main>;
}
