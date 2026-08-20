import type { Metadata } from "next";
import { createHash } from "node:crypto";
import { requireLearnerMode } from "@/lib/auth/guards";
import { getOwnedLearner, getParentTimezone } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { composeLearnerHome } from "@/lib/learner-home/service";
import { LearnerModeExitForm } from "@/components/learner-mode/exit-form";
import { LearnerLauncher } from "@/components/learner-home/learner-launcher";

export const metadata: Metadata = { title: "Learning mode — Baby Steps" };

export default async function LearnerPage() {
  const { session, authorization } = await requireLearnerMode();
  const learner = await getOwnedLearner(session.sub, authorization.learnerId!,
    calendarDateInTimeZone(await getParentTimezone(session.sub)));
  const contextVersion = authorization.contextVersion ?? 0;
  const home = await composeLearnerHome(authorization.learnerId!, "production", new Date(), contextVersion);
  const contextBinding = createHash("sha256").update([
    session.sid, session.did, authorization.learnerId!, String(contextVersion), "production",
  ].join("\0")).digest("hex").slice(0, 32);

  return (
    <div className="min-h-screen bg-chakra-50">
      <header className="border-b border-chakra-100 bg-white px-6 py-4">
        <p className="text-sm font-semibold text-green-700">Baby Steps learning mode</p>
      </header>
      <main className="mx-auto w-full max-w-4xl px-6 py-12">
        <LearnerLauncher learnerName={learner.displayName} learnerId={authorization.learnerId!}
          contextVersion={contextVersion} contextBinding={contextBinding} initialData={home} />
        <LearnerModeExitForm />
      </main>
    </div>
  );
}
