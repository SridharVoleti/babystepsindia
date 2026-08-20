import type { Metadata } from "next";
import { requireAdminPermission } from "@/lib/auth/guards";
import { queryPrivilegedAudit } from "@/lib/platform-governance/audit-viewer";

export const metadata: Metadata = { title: "Privileged audit — Baby Steps Admin" };

// AD-005 rules 15, 79-91: read-only, bounded, allowlisted-filter privileged
// audit viewer composed live over the three existing append-only activity
// tables — no free-form filter/SQL, no edit/delete/resolve, no bulk
// export. Server-rendered on entry/manual refresh only (rule 107-108).
export default async function PlatformAuditPage({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  await requireAdminPermission("admin.platform.audit.read");
  const to = searchParams.to ?? new Date().toISOString();
  const from = searchParams.from ?? new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const result = await queryPrivilegedAudit({
    from, to,
    staffAccountId: searchParams.staffId || undefined,
    canonicalAction: searchParams.action || undefined,
    caseId: searchParams.caseId || undefined,
    operationChangeId: searchParams.operationChangeId || undefined,
  });

  return (
    <div>
      <h1 className="text-2xl font-bold text-chakra-900">Privileged audit</h1>
      <p className="mt-1 text-sm text-chakra-500">
        Read-only. Bounded, allowlisted filters only — no free-form query, no customer email/name search.
      </p>

      <form method="get" className="card mt-6 grid grid-cols-1 gap-3 p-4 sm:grid-cols-4">
        <div>
          <label className="field-label" htmlFor="from">From</label>
          <input id="from" name="from" type="datetime-local" defaultValue={from.slice(0, 16)} className="field-input" />
        </div>
        <div>
          <label className="field-label" htmlFor="to">To</label>
          <input id="to" name="to" type="datetime-local" defaultValue={to.slice(0, 16)} className="field-input" />
        </div>
        <div>
          <label className="field-label" htmlFor="staffId">Staff account ID</label>
          <input id="staffId" name="staffId" defaultValue={searchParams.staffId ?? ""} className="field-input" />
        </div>
        <div>
          <label className="field-label" htmlFor="action">Canonical action</label>
          <input id="action" name="action" defaultValue={searchParams.action ?? ""} className="field-input" />
        </div>
        <div className="sm:col-span-4">
          <button type="submit" className="btn-primary min-h-[44px] px-4">Apply filters</button>
        </div>
      </form>

      <div className="card mt-4 overflow-x-auto p-0">
        <table className="min-w-full divide-y divide-chakra-100 text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-chakra-500">
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Result</th>
              <th className="px-4 py-3">Reference</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-chakra-100">
            {result.events.map((event) => (
              <tr key={event.id}>
                <td className="px-4 py-3 text-chakra-500">{new Date(event.createdAt).toLocaleString()}</td>
                <td className="px-4 py-3 capitalize text-chakra-700">{event.source.replace("_", " ")}</td>
                <td className="px-4 py-3 text-chakra-900">{event.canonicalAction}</td>
                <td className="px-4 py-3 text-chakra-700">{event.result}</td>
                <td className="px-4 py-3 text-chakra-500">
                  {event.caseId ?? event.operationChangeId ?? event.resourceSafeId ?? "—"}
                </td>
              </tr>
            ))}
            {result.events.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-chakra-400">No privileged activity in this window.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {result.nextCursor && (
        <p className="mt-3 text-sm text-chakra-500">
          More events exist — narrow the time range or staff/action filter to see them.
        </p>
      )}
    </div>
  );
}
