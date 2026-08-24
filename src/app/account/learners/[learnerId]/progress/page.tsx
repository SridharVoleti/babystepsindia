import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireParentManagement } from "@/lib/auth/guards";
import { getOwnedLearner, getParentTimezone, LearnerCreationError } from "@/lib/db/learner-repo";
import { getOwnedLearnerProgressReport } from "@/lib/db/learner-progress-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { MotivationProgressView } from "@/components/progress/motivation-progress";

export const metadata: Metadata = { title: "Learner progress — Baby Steps" };

export default async function LearnerProgressPage({ params }: { params: { learnerId: string } }) {
  const { session } = await requireParentManagement();
  let learner;
  try {
    learner = await getOwnedLearner(session.sub, params.learnerId,
      calendarDateInTimeZone(await getParentTimezone(session.sub)));
  } catch (error) {
    if (error instanceof LearnerCreationError && error.code === "LEARNER_NOT_FOUND") notFound();
    throw error;
  }
  const report = await getOwnedLearnerProgressReport(session.sub, params.learnerId);
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16">
      <Link href="/account" className="text-sm font-medium text-green-700">← Back to account</Link>
      <h1 className="mt-3 text-2xl font-bold text-chakra-900">{learner.displayName}&apos;s progress</h1>
      <Link href={`/account/learners/${params.learnerId}/achievements`}
        className="mt-4 inline-flex min-h-[44px] items-center font-medium text-green-700">
        View achievement history
      </Link>
      <Link href={`/account/learners/${params.learnerId}/consistency`}
        className="ml-4 mt-4 inline-flex min-h-[44px] items-center font-medium text-green-700">
        View weekly consistency
      </Link>
      <div className="card mt-6 divide-y divide-chakra-100">
        {report.length === 0 ? <p className="p-5 text-sm text-chakra-500">No learning progress yet.</p> :
          report.map((item) => <section key={item.appId} className="p-5">
            <h2 className="font-semibold text-chakra-900">{item.appName}</h2>
            <p className="mt-1 text-sm text-chakra-500">Current level: {item.currentLevelKey ?? "Not started"}</p>
            <p className="text-sm text-chakra-500">Current lesson: {item.currentLessonKey ?? "Not started"}</p>
            <p className="text-sm text-chakra-500">Learning time: {item.currentEngagedSeconds} seconds</p>
            {item.progressSummary && <MotivationProgressView progress={item.progressSummary.motivationProgress}
              className="mt-3" />}
          </section>)}
      </div>
    </main>
  );
}

