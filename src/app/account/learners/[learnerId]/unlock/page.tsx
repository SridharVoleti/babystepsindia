import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireParentManagement } from "@/lib/auth/guards";
import { getOwnedLearner, getParentTimezone, LearnerCreationError } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { UnlockAndRedirect } from "@/components/learner-mode/unlock-and-redirect";

export const metadata: Metadata = { title: "Open learner — Baby Steps" };

// PD-001/PD-004: the "Open learner" action. This page is the first place
// in the app that mounts PasskeyUnlock — the AU-002 selection/IA-004
// passkey-unlock backend it calls already exists in full; only the page
// wiring it in was missing.
export default async function UnlockLearnerPage({ params }: { params: { learnerId: string } }) {
  const { session } = await requireParentManagement();
  let learner;
  try {
    learner = getOwnedLearner(session.sub, params.learnerId, calendarDateInTimeZone(getParentTimezone(session.sub)));
  } catch (error) {
    if (error instanceof LearnerCreationError && error.code === "LEARNER_NOT_FOUND") notFound();
    throw error;
  }

  return (
    <main className="mx-auto w-full max-w-md px-6 py-16">
      <Link href="/account" className="text-sm font-medium text-green-700">← Back to dashboard</Link>
      <h1 className="mt-3 text-2xl font-bold text-chakra-900">Open {learner.displayName}</h1>
      <p className="mt-2 text-sm text-chakra-500">Verify this device&apos;s passkey to enter learner mode.</p>
      <UnlockAndRedirect learnerId={params.learnerId} learnerName={learner.displayName} redirectTo="/learner" />
    </main>
  );
}
