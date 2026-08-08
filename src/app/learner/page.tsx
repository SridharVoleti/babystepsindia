import type { Metadata } from "next";
import { requireLearnerMode } from "@/lib/auth/guards";
import { getOwnedLearner, getParentTimezone } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { LearnerModeExitForm } from "@/components/learner-mode/exit-form";

export const metadata: Metadata = { title: "Learning mode — Baby Steps" };

export default async function LearnerPage() {
  const { session, authorization } = await requireLearnerMode();
  const learner = getOwnedLearner(
    session.sub,
    authorization.learnerId!,
    calendarDateInTimeZone(getParentTimezone(session.sub)),
  );

  return (
    <div className="min-h-screen bg-chakra-50">
      <header className="border-b border-chakra-100 bg-white px-6 py-4">
        <p className="text-sm font-semibold text-green-700">Baby Steps learning mode</p>
      </header>
      <main className="mx-auto w-full max-w-2xl px-6 py-12">
        <p className="text-sm font-medium text-chakra-500">Ready to learn</p>
        <h1 className="mt-1 text-3xl font-bold text-chakra-900">Hi, {learner.displayName}</h1>
        <section className="card mt-6 p-6">
          <h2 className="text-lg font-semibold text-chakra-900">Your learning apps</h2>
          <p className="mt-2 text-sm text-chakra-500">
            Available lessons will appear here when the selected learner is eligible to start.
          </p>
        </section>
        <LearnerModeExitForm />
      </main>
    </div>
  );
}
