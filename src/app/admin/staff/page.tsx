import Link from "next/link";
import type { Metadata } from "next";
import { requireAdminPermission } from "@/lib/auth/guards";
import { listStaff } from "@/lib/staff-identity/accounts-repo";

export const metadata: Metadata = { title: "Staff — Baby Steps Admin" };

const ROLE_LABELS: Record<string, string> = {
  support_agent: "Support Agent",
  billing_administrator: "Billing Administrator",
  operations_administrator: "Operations Administrator",
  platform_administrator: "Platform Administrator",
};

// API-AD-009.
export default async function StaffListPage() {
  await requireAdminPermission("admin.staff.list.read");
  const { staff } = listStaff({ limit: 200 });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-chakra-900">Staff</h1>
          <p className="mt-1 text-sm text-chakra-500">Every staff identity, its status and current roles.</p>
        </div>
        <Link href="/admin/staff/invite" className="btn-primary">
          Invite staff
        </Link>
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
                  <Link href={`/admin/staff/${row.id}`} className="text-sm font-medium text-saffron-700 hover:underline">
                    Manage
                  </Link>
                </td>
              </tr>
            ))}
            {staff.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-chakra-400">
                  No staff accounts yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
