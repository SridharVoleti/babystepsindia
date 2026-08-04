import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireVerifiedParent } from "@/lib/auth/guards";
import {
  LearnerCreationError,
  getOwnedLearner,
  getParentTimezone,
  listApprovedAvatars,
} from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { LearnerProfileEditForm } from "@/components/learners/learner-profile-edit-form";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

export const metadata: Metadata = { title: "Edit learner profile — Baby Steps" };

export default async function EditLearnerPage({ params }: { params: { learnerId: string } }) {
  const { session } = await requireVerifiedParent();
  let learner;
  try {
    const asOf = calendarDateInTimeZone(getParentTimezone(session.sub));
    learner = getOwnedLearner(session.sub, params.learnerId, asOf);
  } catch (error) {
    if (error instanceof LearnerCreationError && error.code === "LEARNER_NOT_FOUND") notFound();
    throw error;
  }
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-xl flex-1 px-6 py-12">
        <h1 className="text-2xl font-bold text-chakra-900">Edit learner profile</h1>
        <p className="mt-2 text-sm text-chakra-500">Correct the learner’s name, date of birth, or avatar.</p>
        <LearnerProfileEditForm initialLearner={learner} avatars={listApprovedAvatars()} />
      </main>
      <SiteFooter />
    </div>
  );
}
