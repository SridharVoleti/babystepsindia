import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireParentManagement } from "@/lib/auth/guards";
import {
  LearnerCreationError,
  getOwnedLearner,
  getParentTimezone,
  listApprovedAvatars,
} from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { LearnerProfileEditForm } from "@/components/learners/learner-profile-edit-form";

export const metadata: Metadata = { title: "Edit learner profile — Baby Steps" };

export default async function EditLearnerPage({ params }: { params: { learnerId: string } }) {
  const { session } = await requireParentManagement();
  let learner;
  try {
    const asOf = calendarDateInTimeZone(await getParentTimezone(session.sub));
    learner = await getOwnedLearner(session.sub, params.learnerId, asOf);
  } catch (error) {
    if (error instanceof LearnerCreationError && error.code === "LEARNER_NOT_FOUND") notFound();
    throw error;
  }
  return (
    <main className="mx-auto w-full max-w-xl px-6 py-12">
      <h1 className="text-2xl font-bold text-chakra-900">Edit learner profile</h1>
      <p className="mt-2 text-sm text-chakra-500">Correct the learner’s name, date of birth, or avatar.</p>
      <LearnerProfileEditForm initialLearner={learner} avatars={await listApprovedAvatars()} />
    </main>
  );
}
