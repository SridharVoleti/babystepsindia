import Link from "next/link";
import { requireAdminPermission } from "@/lib/auth/guards";
import { getGovernanceOverview } from "@/lib/platform-governance/dashboard";
import { RecoveryCodeRotateAction } from "@/components/admin/recovery-code-rotate-action";

// AD-005 rules 13, 16-17, 96-99: bounded informational counts/alerts only
// — never itself an authorization decision, never an automatic staff
// mutation. Platform governance route.
export default async function PlatformGovernancePage() {
  await requireAdminPermission("admin.platform.governance.read");
  const overview = await getGovernanceOverview();

  return (
    <div>
      <h1 className="text-2xl font-bold text-chakra-900">Platform governance</h1>
      <p className="mt-1 text-sm text-chakra-500">
        Staff access, administrator recovery and privileged activity — never a Support, Billing, or Operations
        console.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <p className="rounded-lg border p-3 text-sm"><strong>Active staff:</strong> {overview.staffCounts.active}</p>
        <p className="rounded-lg border p-3 text-sm"><strong>Invited:</strong> {overview.staffCounts.invited}</p>
        <p className="rounded-lg border p-3 text-sm"><strong>Suspended:</strong> {overview.staffCounts.suspended}</p>
        <p className="rounded-lg border p-3 text-sm"><strong>Revoked:</strong> {overview.staffCounts.revoked}</p>
      </div>

      <section className="card mt-6 p-5">
        <h2 className="font-semibold text-chakra-900">Security alerts</h2>
        <p className="mt-1 text-xs text-chakra-500">Informational only — never a bypass of any governance rule.</p>
        <ul className="mt-3 space-y-1 text-sm text-chakra-700">
          <li>{overview.securityAlerts.staffWithoutActivePasskey} active staff account(s) with no active passkey</li>
          <li>
            {overview.securityAlerts.lastPlatformAdministratorRisk
              ? "Only one active Platform Administrator exists"
              : "More than one active Platform Administrator exists"}
          </li>
          <li>
            Break-glass recovery codes: {overview.recoveryCodeStatus.activeCount} active (generation {overview.recoveryCodeStatus.generation})
            {overview.securityAlerts.recoveryCodesLow && " — running low"}
          </li>
        </ul>
        <div className="mt-4">
          <RecoveryCodeRotateAction />
        </div>
      </section>

      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/admin/platform/staff" className="btn-secondary inline-flex min-h-[44px] items-center px-4">
          Staff governance
        </Link>
        <Link href="/admin/platform/audit" className="btn-secondary inline-flex min-h-[44px] items-center px-4">
          Privileged audit
        </Link>
      </div>

      <p className="mt-6 text-sm text-chakra-500">
        {overview.recentPrivilegedActionCount} privileged action(s) recorded across Support, Billing, and
        Operations in the last 24 hours.
      </p>
    </div>
  );
}
