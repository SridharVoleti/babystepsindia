import type { Metadata } from "next";
import { listAuditLogWithContext } from "@/lib/db/audit";
import { StatusPill } from "@/components/admin/status-pill";

export const metadata: Metadata = { title: "Audit log — Baby Steps Admin" };

export default function AuditLogPage() {
  const entries = listAuditLogWithContext();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-chakra-900">Audit log</h1>
        <p className="mt-1 text-sm text-chakra-500">
          Every subscription change — webhook, admin override, or cron — with
          who made it (REQ-08 §7).
        </p>
      </div>

      <div className="card overflow-x-auto p-6">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-chakra-100 text-left text-xs font-medium uppercase tracking-wide text-chakra-400">
              <th className="py-2 pr-4">When</th>
              <th className="py-2 pr-4">User</th>
              <th className="py-2 pr-4">Product</th>
              <th className="py-2 pr-4">Changed by</th>
              <th className="py-2 pr-4">Type</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2">Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-chakra-50">
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className="py-2 pr-4 tabular-nums text-chakra-500">
                  {entry.created_at}
                </td>
                <td className="py-2 pr-4 text-chakra-900">
                  {entry.userEmail ?? "—"}
                </td>
                <td className="py-2 pr-4 text-chakra-900">
                  {entry.productLabel ?? "—"}
                </td>
                <td className="py-2 pr-4 text-chakra-700">{entry.changed_by}</td>
                <td className="py-2 pr-4 text-chakra-700">{entry.change_type}</td>
                <td className="py-2 pr-4">
                  {entry.old_status && (
                    <span className="text-chakra-400">{entry.old_status} → </span>
                  )}
                  <StatusPill status={entry.new_status} />
                </td>
                <td className="py-2 text-chakra-600">{entry.note ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {entries.length === 0 && (
          <p className="py-8 text-center text-sm text-chakra-400">
            No audit events yet.
          </p>
        )}
      </div>
    </div>
  );
}
