// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { bootstrapFirstPlatformAdministrator } from "@/lib/staff-identity/bootstrap";
import { activeRoleKeys, findStaffById } from "@/lib/staff-identity/accounts-repo";
import { isSuperAdminDisplay } from "@/lib/staff-identity/roles";
import { activeStaffPasskeyCount } from "@/lib/webauthn/staff-service";
import { ensureBootstrapPlatformAdmin } from "./helpers/staff-session-fixture";

const now = new Date("2026-08-16T10:00:00.000Z");

beforeEach(() => {
  useInMemoryDb();
});

describe("AD-001 bootstrap", () => {
  it("seeds exactly one Platform Administrator with all four V1 roles (business rule 139)", () => {
    const staffAccountId = ensureBootstrapPlatformAdmin(now);
    const staff = findStaffById(staffAccountId)!;
    expect(staff.status).toBe("active");
    const roles = activeRoleKeys(staffAccountId);
    expect(isSuperAdminDisplay(roles)).toBe(true);
  });

  it("issues no usable passkey — first login must enroll one before real MFA access", async () => {
    const staffAccountId = ensureBootstrapPlatformAdmin(now);
    expect(await activeStaffPasskeyCount(staffAccountId)).toBe(0);
  });

  it("is a no-op if a Platform Administrator already exists", () => {
    bootstrapFirstPlatformAdministrator(getDb(), now);
    const second = bootstrapFirstPlatformAdministrator(getDb(), now);
    expect(second).toBeNull();
    const count = (getDb().prepare("select count(*) as n from staff_accounts").get() as { n: number }).n;
    expect(count).toBe(1);
  });
});
