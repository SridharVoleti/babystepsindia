import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireParentManagement } from "@/lib/auth/guards";
import { getOwnedLearner, getParentTimezone, LearnerCreationError } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { UnlockAndRedirect } from "@/components/learner-mode/unlock-and-redirect";

export const metadata: Metadata = { title: "Open learner — Baby Steps" };

// PD-001/PD-004: the "Open learner" action. Enters learner mode directly —
// no passkey ceremony required.
export default async function UnlockLearnerPage({ params }: { params: { learnerId: string } }) {
  const { session } = await requireParentManagement();
  let learner;
  try {
    learner = await getOwnedLearner(session.sub, params.learnerId, calendarDateInTimeZone(await getParentTimezone(session.sub)));
  } catch (error) {
    if (error instanceof LearnerCreationError && error.code === "LEARNER_NOT_FOUND") notFound();
    throw error;
  }

  return (
    <main className="mx-auto w-full max-w-md px-6 py-16">
      <Link href="/account" className="text-sm font-medium text-green-700">← Back to dashboard</Link>
      <h1 className="mt-3 text-2xl font-bold text-chakra-900">Open {learner.displayName}</h1>
      <UnlockAndRedirect learnerId={params.learnerId} learnerName={learner.displayName} redirectTo="/learner" />
    </main>
  );
}
