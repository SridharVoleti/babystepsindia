import type { Metadata } from "next";
import { requireAdminPermission } from "@/lib/auth/guards";
import { listAllLearnersForAdmin } from "@/lib/db/learner-repo";
import { LearnerSessionLimitRow } from "@/components/admin/learner-session-limit-row";

export const metadata: Metadata = { title: "Learners — Baby Steps Admin" };

export default async function AdminLearnersPage({
  searchParams,
}: {
  searchParams: { search?: string };
}) {
  await requireAdminPermission("admin.learner.list");
  const learners = await listAllLearnersForAdmin(searchParams.search);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-chakra-900">Learners</h1>
        <p className="mt-1 text-sm text-chakra-500">
          Every learner across every parent account. Exempt a learner from the
          weekly session cap (2 free sessions/app/week by default) — for QA
          and test accounts, not for real customer use.
        </p>
      </div>

      <form method="get" className="card flex flex-wrap items-end gap-4 p-5">
        <div>
          <label htmlFor="search" className="field-label">Search</label>
          <input
            id="search"
            name="search"
            defaultValue={searchParams.search ?? ""}
            placeholder="learner name or parent email"
            className="field-input"
          />
        </div>
        <button type="submit" className="btn-secondary">Apply</button>
      </form>

      <div className="card divide-y divide-chakra-100">
        {learners.length === 0 ? (
          <p className="p-5 text-sm text-chakra-500">No learners match.</p>
        ) : (
          learners.map((learner) => <LearnerSessionLimitRow key={learner.id} learner={learner} />)
        )}
      </div>
    </div>
  );
}
