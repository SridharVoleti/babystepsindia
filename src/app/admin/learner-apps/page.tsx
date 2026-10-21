import type { Metadata } from "next";
import { requireAdminPermission } from "@/lib/auth/guards";
import { listLearnerAppsForAdmin } from "@/lib/db/learner-app-admin-repo";
import { LearnerAppRow } from "@/components/admin/learner-app-row";

export const metadata: Metadata = { title: "Learner apps — Baby Steps Admin" };

export default async function AdminLearnerAppsPage({
  searchParams,
}: {
  searchParams: { search?: string };
}) {
  await requireAdminPermission("admin.learner_app.list");
  const rows = await listLearnerAppsForAdmin(searchParams.search);

  const byApp = new Map<string, { appName: string; rows: typeof rows }>();
  for (const row of rows) {
    const group = byApp.get(row.appId) ?? { appName: row.appName, rows: [] };
    group.rows.push(row);
    byApp.set(row.appId, group);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-chakra-900">Learner apps</h1>
        <p className="mt-1 text-sm text-chakra-500">
          Every learner&apos;s apps, grouped by app. Set a per-app weekly session cap (overrides the
          learner-wide setting on <a href="/admin/learners" className="underline">Learners</a>) and
          move the access end date. Changing the end date rewrites the learner&apos;s latest entitlement
          period for that app.
        </p>
      </div>

      <form method="get" className="card flex flex-wrap items-end gap-4 p-5">
        <div>
          <label htmlFor="search" className="field-label">Search</label>
          <input
            id="search"
            name="search"
            defaultValue={searchParams.search ?? ""}
            placeholder="app, learner name or parent email"
            className="field-input"
          />
        </div>
        <button type="submit" className="btn-secondary">Apply</button>
      </form>

      {byApp.size === 0 ? (
        <div className="card p-5 text-sm text-chakra-500">No learner apps match.</div>
      ) : (
        [...byApp.entries()].map(([appId, group]) => (
          <section key={appId} className="card divide-y divide-chakra-100">
            <h2 className="p-5 text-lg font-semibold text-chakra-900">
              {group.appName} <span className="text-sm font-normal text-chakra-400">({group.rows.length})</span>
            </h2>
            {group.rows.map((row) => <LearnerAppRow key={`${row.learnerId}:${row.appId}`} row={row} />)}
          </section>
        ))
      )}
    </div>
  );
}
