import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireAdminPermission } from "@/lib/auth/guards";
import { activeRoleKeys, findStaffById } from "@/lib/staff-identity/accounts-repo";
import { StaffStatusRolesForm } from "@/components/admin/staff-status-roles-form";

export const metadata: Metadata = { title: "Manage staff — Baby Steps Admin" };

// API-AD-007/API-AD-008.
export default async function StaffDetailPage({ params }: { params: { staffId: string } }) {
  await requireAdminPermission("admin.staff.roles.update");
  const staff = findStaffById(params.staffId);
  if (!staff) notFound();
  const roleKeys = activeRoleKeys(staff.id);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-chakra-900">{staff.normalized_email}</h1>
        <p className="mt-1 text-sm text-chakra-500">
          Status: <span className="font-medium capitalize text-chakra-700">{staff.status}</span>
        </p>
      </div>
      <StaffStatusRolesForm
        staffAccountId={staff.id}
        currentStatus={staff.status}
        currentRoleKeys={roleKeys}
        version={staff.version}
      />
    </div>
  );
}
