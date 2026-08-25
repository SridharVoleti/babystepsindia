import type { Metadata } from "next";
import { requireParentManagement } from "@/lib/auth/guards";
import { getParentTimezone, listApprovedAvatars } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";
import { AddLearnerForm } from "@/components/learners/add-learner-form";

export const metadata: Metadata = { title: "Add learner — Baby Steps" };

export default async function NewLearnerPage() {
  const { session } = await requireParentManagement();
  const maxDate = calendarDateInTimeZone(await getParentTimezone(session.sub));
  return (
    <main className="mx-auto w-full max-w-xl px-6 py-12">
      <h1 className="text-2xl font-bold text-chakra-900">Add a learner</h1>
      <p className="mt-2 text-sm text-chakra-500">Create a profile for your child to start learning.</p>
      <AddLearnerForm avatars={await listApprovedAvatars()} maxDate={maxDate} />
    </main>
  );
}
