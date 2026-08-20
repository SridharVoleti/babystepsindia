// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { acceptInvitation, createInvitation } from "@/lib/staff-identity/invitation-service";
import { StaffIdentityError } from "@/lib/staff-identity/errors";
import { findStaffById } from "@/lib/staff-identity/accounts-repo";
import { ensureBootstrapPlatformAdmin } from "./helpers/staff-session-fixture";

const now = new Date("2026-08-16T10:00:00.000Z");

beforeEach(() => {
  useInMemoryDb();
});

function bootstrapAdmin() {
  return ensureBootstrapPlatformAdmin(now);
}

describe("AD-001 staff invitations", () => {
  it("creates a 24h-expiring invitation with the requested initial roles", async () => {
    const adminId = bootstrapAdmin();
    const { staffAccountId, expiresAt } = await createInvitation({
      byStaffId: adminId,
      email: "New.Agent@Example.com",
      initialRoleKeys: ["support_agent"],
      reason: "Onboarding a new staff member per manager approval on this ticket.",
      now,
    });
    const staff = findStaffById(staffAccountId)!;
    expect(staff.status).toBe("invited");
    expect(staff.normalized_email).toBe("new.agent@example.com");
    expect(new Date(expiresAt).getTime() - now.getTime()).toBe(24 * 60 * 60_000);
  });

  it("is idempotent for a still-pending invite to the same email (API-AD-001)", async () => {
    const adminId = bootstrapAdmin();
    const first = await createInvitation({ byStaffId: adminId, email: "dupe@example.com", initialRoleKeys: ["support_agent"], reason: "Onboarding a new staff member per manager approval on this ticket.", now });
    const second = await createInvitation({ byStaffId: adminId, email: "dupe@example.com", initialRoleKeys: ["support_agent"], reason: "Onboarding a new staff member per manager approval on this ticket.", now });
    expect(second.staffAccountId).toBe(first.staffAccountId);
    expect(second.expiresAt).toBe(first.expiresAt);
  });

  it("rejects inviting an email that already belongs to a parent (business rule 3)", async () => {
    const adminId = bootstrapAdmin();
    await sqliteAuthAdapter.signUp("existing-parent@example.com", "CorrectHorse1!");
    await expect(
      createInvitation({ byStaffId: adminId, email: "existing-parent@example.com", initialRoleKeys: ["support_agent"], reason: "Onboarding a new staff member per manager approval on this ticket.", now }),
    ).rejects.toEqual(new StaffIdentityError("EMAIL_ALREADY_PARENT"));
  });

  it("rejects re-inviting an already-active staff email", async () => {
    const adminId = bootstrapAdmin();
    const { staffAccountId } = await createInvitation({ byStaffId: adminId, email: "active@example.com", initialRoleKeys: ["support_agent"], reason: "Onboarding a new staff member per manager approval on this ticket.", now });
    await acceptInvitation({ staffAccountId, password: "CorrectHorse1!", now });
    await expect(
      createInvitation({ byStaffId: adminId, email: "active@example.com", initialRoleKeys: ["support_agent"], reason: "Onboarding a new staff member per manager approval on this ticket.", now }),
    ).rejects.toEqual(new StaffIdentityError("STAFF_ACCOUNT_ALREADY_EXISTS"));
  });

  it("accepts an invitation, setting the password and moving invited -> active", async () => {
    const adminId = bootstrapAdmin();
    const { staffAccountId } = await createInvitation({ byStaffId: adminId, email: "accept-me@example.com", initialRoleKeys: ["billing_administrator"], reason: "Onboarding a new staff member per manager approval on this ticket.", now });
    const result = await acceptInvitation({ staffAccountId, password: "CorrectHorse1!", now });
    expect(result.staffAccountId).toBe(staffAccountId);
    const staff = findStaffById(staffAccountId)!;
    expect(staff.status).toBe("active");
    expect(staff.activated_at).toBeTruthy();
  });

  it("rejects accepting an expired invitation (business rule 29)", async () => {
    const adminId = bootstrapAdmin();
    const { staffAccountId } = await createInvitation({ byStaffId: adminId, email: "late@example.com", initialRoleKeys: ["support_agent"], reason: "Onboarding a new staff member per manager approval on this ticket.", now });
    const later = new Date(now.getTime() + 24 * 60 * 60_000 + 1);
    await expect(acceptInvitation({ staffAccountId, password: "CorrectHorse1!", now: later })).rejects.toEqual(
      new StaffIdentityError("INVITATION_EXPIRED"),
    );
  });

  it("rejects a weak password on acceptance", async () => {
    const adminId = bootstrapAdmin();
    const { staffAccountId } = await createInvitation({ byStaffId: adminId, email: "weak@example.com", initialRoleKeys: ["support_agent"], reason: "Onboarding a new staff member per manager approval on this ticket.", now });
    await expect(acceptInvitation({ staffAccountId, password: "weak", now })).rejects.toEqual(
      new StaffIdentityError("INVALID_PASSWORD"),
    );
  });
});
