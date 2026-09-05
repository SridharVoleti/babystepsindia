import Link from "next/link";
import type { Metadata } from "next";
import { requireParentManagement } from "@/lib/auth/guards";
import { getParentTimezone, listOwnedLearners } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { ResetWeeklyLimitButton } from "@/components/learners/reset-weekly-limit-button";

export const metadata: Metadata = { title: "Learners — Baby Steps" };

export default async function LearnersIndexPage() {
  const { session } = await requireParentManagement();
  const learners = await listOwnedLearners(session.sub, calendarDateInTimeZone(await getParentTimezone(session.sub)));

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16">
      <Link href="/account" className="text-sm font-medium text-green-700">← Back to dashboard</Link>
      <div className="mt-3 flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-chakra-900">Learners</h1>
        <Link href="/account/learners/new" className="btn-primary">Add learner</Link>
      </div>

      <div className="card mt-6 divide-y divide-chakra-100">
        {learners.length === 0 ? (
          <p className="p-5 text-sm text-chakra-500">No learner profiles yet.</p>
        ) : (
          learners.map((learner) => (
            <div key={learner.id} className="flex flex-wrap items-center justify-between gap-3 p-5">
              <p className="font-medium text-chakra-900">{learner.displayName}</p>
              <div className="flex gap-4">
                <Link href={`/account/learners/${learner.id}/apps`}
                  className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700 hover:text-green-800">
                  View apps
                </Link>
                <Link href={`/account/learners/${learner.id}/edit`}
                  className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700 hover:text-green-800">
                  Edit profile
                </Link>
                <Link href={`/account/learners/${learner.id}/unlock`}
                  className="inline-flex min-h-[44px] items-center text-sm font-medium text-green-700 hover:text-green-800">
                  Open learner
                </Link>
                <ResetWeeklyLimitButton learnerId={learner.id} />
              </div>
            </div>
          ))
        )}
      </div>
    </main>
  );
}
