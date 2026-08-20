import { resolveDbClient } from "@/lib/db-client";
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
export async function getGovernanceOverview(now = new Date()): Promise<GovernanceOverview> {
  const db = resolveDbClient();
  const statusRows = await db.all<{ status: string; n: number }>(
    "select status, count(*) as n from staff_accounts group by status",
  );
  const staffCounts = { active: 0, invited: 0, suspended: 0, revoked: 0 };
  for (const row of statusRows) {
    if (row.status in staffCounts) (staffCounts as Record<string, number>)[row.status] = row.n;
  }

  const staffWithoutActivePasskey = await db.get<{ n: number }>(
    `select count(*) as n from staff_accounts a
     where a.status='active' and not exists (
       select 1 from staff_passkey_credentials c where c.staff_account_id=a.id and c.status='active'
     )`,
  );

  const recoveryCodeStatus = await getRecoveryCodeStatus();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const recentCount = await db.get<{ n: number }>(
    `select
       (select count(*) from staff_audit_log where created_at>=?) +
       (select count(*) from support_case_activity where created_at>=?) +
       (select count(*) from platform_operation_activity where created_at>=?) as n`,
    [dayAgo, dayAgo, dayAgo],
  );

  return {
    staffCounts,
    securityAlerts: {
      staffWithoutActivePasskey: staffWithoutActivePasskey!.n,
      // Rule 29: risk warning only — never a bypass of the last-admin rule.
      // NOTE: countActivePlatformAdministrators() (staff-identity/accounts-repo.ts)
      // is still sync/raw getDb() — no async twin exists for it yet, unlike
      // findStaffById/activeRoleKeys. This call will still crash on Vercel/
      // Postgres until that twin is added; flagged, not fixed here (out of
      // this batch's scope).
      lastPlatformAdministratorRisk: countActivePlatformAdministrators() <= 1,
      recoveryCodesLow: recoveryCodeStatus.activeCount < 2,
    },
    recoveryCodeStatus,
    recentPrivilegedActionCount: recentCount!.n,
  };
}
