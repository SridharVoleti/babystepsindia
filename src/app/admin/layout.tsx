import { requireAdmin } from "@/lib/auth/guards";
import { findStaffByIdAsync } from "@/lib/staff-identity/accounts-repo";
import { isSuperAdminDisplay } from "@/lib/staff-identity/roles";
import { AdminNav } from "@/components/admin/admin-nav";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireAdmin();
  const staff = await findStaffByIdAsync(session.staffAccountId);

  return (
    <div className="min-h-screen bg-cream">
      <AdminNav
        displayName={staff?.display_name ?? staff?.normalized_email ?? "Staff"}
        roleKeys={session.roleKeys}
        isSuperAdmin={isSuperAdminDisplay(session.roleKeys)}
      />
      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
