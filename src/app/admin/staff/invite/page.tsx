import type { Metadata } from "next";
import { requireAdminPermission } from "@/lib/auth/guards";
import { InviteStaffForm } from "@/components/admin/invite-staff-form";

export const metadata: Metadata = { title: "Invite staff — Baby Steps Admin" };

// API-AD-001.
export default async function InviteStaffPage() {
  await requireAdminPermission("admin.staff.invitation.create");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-chakra-900">Invite staff</h1>
        <p className="mt-1 text-sm text-chakra-500">
          Creates a 24-hour invitation for a new staff identity — never a promoted parent account.
        </p>
      </div>
      <InviteStaffForm />
    </div>
  );
}
