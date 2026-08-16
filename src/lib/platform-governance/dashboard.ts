import { getDb } from "@/lib/db/client";
import { countActivePlatformAdministrators } from "@/lib/staff-identity/accounts-repo";
import { getRecoveryCodeStatus } from "@/lib/platform-governance/recovery-codes";

export type GovernanceOverview = {
  staffCounts: { active: number; invited: number; suspended: number; revoked: number };
  securityAlerts: {
    staffWithoutActivePasskey: number;
    lastPlatformAdministratorRisk: boolean;
    recoveryCodesLow: boolean;
  };
  recoveryCodeStatus: { activeCount: number; generation: number };
  recentPrivilegedActionCount: number;
};

// API-AD-026. Rules 16-17, 96-99: informational-only counts/alerts — never
// themselves an authorization decision and never auto-mutate staff state.
export function getGovernanceOverview(now = new Date()): GovernanceOverview {
  const db = getDb();
  const statusRows = db.prepare("select status, count(*) as n from staff_accounts group by status").all() as
    Array<{ status: string; n: number }>;
  const staffCounts = { active: 0, invited: 0, suspended: 0, revoked: 0 };
  for (const row of statusRows) {
    if (row.status in staffCounts) (staffCounts as Record<string, number>)[row.status] = row.n;
  }

  const staffWithoutActivePasskey = db
    .prepare(
      `select count(*) as n from staff_accounts a
       where a.status='active' and not exists (
         select 1 from staff_passkey_credentials c where c.staff_account_id=a.id and c.status='active'
       )`,
    )
    .get() as { n: number };

  const recoveryCodeStatus = getRecoveryCodeStatus();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const recentCount = db
    .prepare(
      `select
         (select count(*) from staff_audit_log where created_at>=?) +
         (select count(*) from support_case_activity where created_at>=?) +
         (select count(*) from platform_operation_activity where created_at>=?) as n`,
    )
    .get(dayAgo, dayAgo, dayAgo) as { n: number };

  return {
    staffCounts,
    securityAlerts: {
      staffWithoutActivePasskey: staffWithoutActivePasskey.n,
      // Rule 29: risk warning only — never a bypass of the last-admin rule.
      lastPlatformAdministratorRisk: countActivePlatformAdministrators() <= 1,
      recoveryCodesLow: recoveryCodeStatus.activeCount < 2,
    },
    recoveryCodeStatus,
    recentPrivilegedActionCount: recentCount.n,
  };
}
