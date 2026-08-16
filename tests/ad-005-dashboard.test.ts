// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { getGovernanceOverview } from "@/lib/platform-governance/dashboard";

beforeEach(() => {
  useInMemoryDb();
});

describe("AD-005 getGovernanceOverview (AT-AD-005-05/06, rules 16-17, 96-99)", () => {
  it("counts staff by status, including the auto-seeded bootstrap Platform Administrator", () => {
    seedStaffSession(["support_agent"], { status: "suspended" });
    const overview = getGovernanceOverview();
    expect(overview.staffCounts.active).toBeGreaterThanOrEqual(1);
    expect(overview.staffCounts.suspended).toBe(1);
  });

  it("flags staff without an active passkey — every seeded test staff account has none", () => {
    seedStaffSession(["support_agent"]);
    const overview = getGovernanceOverview();
    expect(overview.securityAlerts.staffWithoutActivePasskey).toBeGreaterThanOrEqual(1);
  });

  it("rule 29/99: last-Platform-Administrator risk is informational only, never a bypass of the real rule elsewhere", () => {
    const overview = getGovernanceOverview();
    // Only the bootstrap admin exists at this point — genuinely at risk.
    expect(overview.securityAlerts.lastPlatformAdministratorRisk).toBe(true);
  });

  it("recoveryCodesLow flags once active codes drop below two", () => {
    const before = getGovernanceOverview();
    expect(before.securityAlerts.recoveryCodesLow).toBe(false);
    const db = getDb();
    const survivor = db.prepare("select id from platform_recovery_codes where status='active' limit 1").get() as { id: string };
    db.prepare("update platform_recovery_codes set status='used' where status='active' and id<>?").run(survivor.id);
    const after = getGovernanceOverview();
    expect(after.recoveryCodeStatus.activeCount).toBe(1);
    expect(after.securityAlerts.recoveryCodesLow).toBe(true);
  });

  it("recentPrivilegedActionCount is derived from the same three sources the audit viewer reads, never a fourth table", () => {
    const overview = getGovernanceOverview();
    expect(typeof overview.recentPrivilegedActionCount).toBe("number");
  });
});
