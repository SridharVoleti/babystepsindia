import Link from "next/link";
import { signOutStaffAction } from "@/app/admin/actions";

const ROLE_LABELS: Record<string, string> = {
  support_agent: "Support Agent",
  billing_administrator: "Billing Administrator",
  operations_administrator: "Operations Administrator",
  platform_administrator: "Platform Administrator",
};

// AD-001 business rules 107-109: shows the current staff identity and
// active roles, server-authoritative (passed down from the layout's real
// session read) — never a client role-switcher. Super Admin is a display
// label only, derived from holding all four roles.
export function AdminNav({
  displayName,
  roleKeys,
  isSuperAdmin,
}: {
  displayName: string;
  roleKeys: string[];
  isSuperAdmin: boolean;
}) {
  return (
    <header className="border-b border-chakra-100 bg-white">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div className="flex items-center gap-6">
          <Link href="/admin" className="text-lg font-bold text-chakra-900">
            Baby Steps Admin
          </Link>
          <nav className="flex items-center gap-5 text-sm font-medium text-chakra-600">
            <Link href="/admin" className="hover:text-chakra-900">
              Overview
            </Link>
            <Link href="/admin/apps" className="hover:text-chakra-900">
              Apps
            </Link>
            <Link href="/admin/learners" className="hover:text-chakra-900">
              Learners
            </Link>
            <Link href="/admin/analytics" className="hover:text-chakra-900">
              Analytics
            </Link>
            <Link href="/admin/staff" className="hover:text-chakra-900">
              Staff
            </Link>
            <Link href="/admin/grant" className="hover:text-chakra-900">
              Grant access
            </Link>
            <Link href="/admin/audit" className="hover:text-chakra-900">
              Audit log
            </Link>
            <Link href="/admin/restore" className="hover:text-chakra-900">
              Restore account
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-4 text-sm">
          <div className="text-right">
            <p className="font-medium text-chakra-900">
              {displayName}
              {isSuperAdmin && (
                <span className="ml-2 rounded-full bg-saffron-100 px-2 py-0.5 text-xs font-semibold text-saffron-800">
                  Super Admin
                </span>
              )}
            </p>
            <p className="text-xs text-chakra-500">
              {roleKeys.map((key) => ROLE_LABELS[key] ?? key).join(", ") || "No roles assigned"}
            </p>
          </div>
          <form action={signOutStaffAction}>
            <button type="submit" className="btn-secondary py-1.5 text-xs">
              Log out
            </button>
          </form>
        </div>
      </div>
      <div className="tricolor-rule" />
    </header>
  );
}
