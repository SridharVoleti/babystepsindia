import Link from "next/link";
import type { Metadata } from "next";
import { requireAdminPermission } from "@/lib/auth/guards";
import { listStaff } from "@/lib/staff-identity/accounts-repo";
import { IssueRecoverySessionAction } from "@/components/admin/issue-recovery-session-action";

export const metadata: Metadata = { title: "Staff governance — Baby Steps Admin" };

const ROLE_LABELS: Record<string, string> = {
  support_agent: "Support Agent",
  billing_administrator: "Billing Administrator",
  operations_administrator: "Operations Administrator",
  platform_administrator: "Platform Administrator",
};

// AD-005 rule 14: /admin/platform/staff. Reuses AD-001's own listStaff and
// status/role authority (linked out to /admin/staff/{id}) rather than
// re-implementing staff governance — this page's own addition is the
// AD-005 recovery-session action (rules 38-41, API-AD-027).
export default async function PlatformStaffGovernancePage() {
  const session = await requireAdminPermission("admin.platform.governance.read");
  const { staff } = listStaff({ limit: 200 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-chakra-900">Staff governance</h1>
        <p className="mt-1 text-sm text-chakra-500">
          Status and role changes remain AD-001 authority (<Link href="/admin/staff" className="underline">full staff list</Link>).
          This view adds passkey-recovery session issuance for a staff member who has lost every passkey.
        </p>
      </div>

      <div className="card overflow-x-auto p-0">
        <table className="min-w-full divide-y divide-chakra-100 text-sm">
          <thead>
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-chakra-500">
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Roles</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-chakra-100">
            {staff.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-3 text-chakra-900">{row.normalized_email}</td>
                <td className="px-4 py-3 capitalize text-chakra-700">{row.status}</td>
                <td className="px-4 py-3 text-chakra-700">
                  {row.roleKeys.map((key) => ROLE_LABELS[key] ?? key).join(", ") || "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  {row.id !== session.staffAccountId && ["active", "suspended"].includes(row.status) && (
                    <IssueRecoverySessionAction targetStaffId={row.id} targetEmail={row.normalized_email} />
                  )}
                </td>
              </tr>
            ))}
            {staff.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-chakra-400">No staff accounts yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
