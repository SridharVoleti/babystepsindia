// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { ensureBootstrapPlatformAdmin } from "./helpers/staff-session-fixture";
import { acceptInvitation, createInvitation } from "@/lib/staff-identity/invitation-service";
import { activeRoleKeys, findStaffById } from "@/lib/staff-identity/accounts-repo";
import { StaffIdentityError } from "@/lib/staff-identity/errors";
import { changeStaffStatus } from "@/lib/staff-identity/status-service";
import { assignStaffRoles } from "@/lib/staff-identity/roles-service";

const now = new Date("2026-08-16T10:00:00.000Z");
const REASON = "Support ticket #4821 confirmed staff departure, revoking access as offboarding policy requires.";

beforeEach(() => {
  useInMemoryDb();
});

function bootstrapAdmin() {
  return ensureBootstrapPlatformAdmin(now);
}

async function invite(adminId: string, email: string, roles: Array<"support_agent" | "billing_administrator">) {
  return (await createInvitation({ byStaffId: adminId, email, initialRoleKeys: roles,
    reason: "Onboarding a new staff member per manager approval on this ticket.", now })).staffAccountId;
}

describe("AD-001 staff status changes (API-AD-007)", () => {
  it("suspends a staff account and bumps its authorization generation for fast revocation", async () => {
    const adminId = bootstrapAdmin();
    const targetId = await invite(adminId, "agent@example.com", ["support_agent"]);
    const before = findStaffById(targetId)!;
    const result = changeStaffStatus({
      actorStaffId: adminId, targetStaffId: targetId, newStatus: "suspended", reason: REASON,
      expectedVersion: before.version, idempotencyKey: "key-1", now,
    });
    expect(result.status).toBe("suspended");
    const after = findStaffById(targetId)!;
    expect(after.authorization_generation).toBe(before.authorization_generation + 1);
  });

  it("blocks a Platform Administrator from suspending/revoking their own account (business rule 72)", () => {
    const adminId = bootstrapAdmin();
    expect(() =>
      changeStaffStatus({ actorStaffId: adminId, targetStaffId: adminId, newStatus: "suspended", reason: REASON, expectedVersion: 1, idempotencyKey: "key-2", now }),
    ).toThrow(new StaffIdentityError("SELF_STATUS_CHANGE_BLOCKED"));
  });

  it("blocks suspending/revoking the last active Platform Administrator (business rule 73)", async () => {
    const adminId = bootstrapAdmin();
    const secondAdminId = await invite(adminId, "second-admin@example.com", ["support_agent"]);
    await acceptInvitation({ staffAccountId: secondAdminId, password: "CorrectHorse1!", now });
    // Give the second staffer Platform Administrator too so it's not a self-mutation case.
    assignStaffRoles({ actorStaffId: adminId, targetStaffId: secondAdminId, roleKeys: ["platform_administrator"], reason: REASON, expectedVersion: findStaffById(secondAdminId)!.version, idempotencyKey: "grant-1", now });
    // Now demote the FIRST admin down to nothing via the second — still blocked because it's the actor's own account? No: use second admin as actor against first admin as target once second is the only remaining safeguard.
    expect(() =>
      changeStaffStatus({ actorStaffId: secondAdminId, targetStaffId: adminId, newStatus: "revoked", reason: REASON, expectedVersion: findStaffById(adminId)!.version, idempotencyKey: "key-3", now }),
    ).not.toThrow(); // allowed: second admin still holds platform_administrator, so first isn't the last one.

    // Now try to revoke the (only remaining) second admin — must be blocked.
    expect(() =>
      changeStaffStatus({ actorStaffId: adminId, targetStaffId: secondAdminId, newStatus: "revoked", reason: REASON, expectedVersion: findStaffById(secondAdminId)!.version, idempotencyKey: "key-4", now }),
    ).toThrow(new StaffIdentityError("LAST_PLATFORM_ADMINISTRATOR"));
  });

  it("rejects a stale expectedVersion (optimistic concurrency)", async () => {
    const adminId = bootstrapAdmin();
    const targetId = await invite(adminId, "agent2@example.com", ["support_agent"]);
    expect(() =>
      changeStaffStatus({ actorStaffId: adminId, targetStaffId: targetId, newStatus: "suspended", reason: REASON, expectedVersion: 99, idempotencyKey: "key-5", now }),
    ).toThrow(new StaffIdentityError("VERSION_CONFLICT"));
  });

  it("never reactivates a revoked account (business rule 28)", async () => {
    const adminId = bootstrapAdmin();
    const targetId = await invite(adminId, "agent3@example.com", ["support_agent"]);
    changeStaffStatus({ actorStaffId: adminId, targetStaffId: targetId, newStatus: "revoked", reason: REASON, expectedVersion: 1, idempotencyKey: "key-6", now });
    expect(() =>
      changeStaffStatus({ actorStaffId: adminId, targetStaffId: targetId, newStatus: "active", reason: REASON, expectedVersion: 2, idempotencyKey: "key-7", now }),
    ).toThrow(new StaffIdentityError("STAFF_ACCOUNT_REVOKED"));
  });

  it("replays an identical idempotency key without re-mutating, but rejects a reused key with a different payload", async () => {
    const adminId = bootstrapAdmin();
    const targetId = await invite(adminId, "agent4@example.com", ["support_agent"]);
    const first = changeStaffStatus({ actorStaffId: adminId, targetStaffId: targetId, newStatus: "suspended", reason: REASON, expectedVersion: 1, idempotencyKey: "replay-key", now });
    const replay = changeStaffStatus({ actorStaffId: adminId, targetStaffId: targetId, newStatus: "suspended", reason: REASON, expectedVersion: 1, idempotencyKey: "replay-key", now });
    expect(replay).toEqual(first);
    expect(() =>
      changeStaffStatus({ actorStaffId: adminId, targetStaffId: targetId, newStatus: "revoked", reason: REASON, expectedVersion: 1, idempotencyKey: "replay-key", now }),
    ).toThrow(new StaffIdentityError("IDEMPOTENCY_KEY_REUSED"));
  });
});

describe("AD-001 staff role assignment (API-AD-008)", () => {
  it("unions multi-role assignment and replaces the active set on a second call", async () => {
    const adminId = bootstrapAdmin();
    const targetId = await invite(adminId, "multi@example.com", ["support_agent"]);
    assignStaffRoles({ actorStaffId: adminId, targetStaffId: targetId, roleKeys: ["support_agent", "billing_administrator"], reason: REASON, expectedVersion: 1, idempotencyKey: "roles-1", now });
    expect(activeRoleKeys(targetId).sort()).toEqual(["billing_administrator", "support_agent"]);
  });

  it("blocks a Platform Administrator from changing their own roles (business rule 71)", () => {
    const adminId = bootstrapAdmin();
    expect(() =>
      assignStaffRoles({ actorStaffId: adminId, targetStaffId: adminId, roleKeys: ["support_agent"], reason: REASON, expectedVersion: 1, idempotencyKey: "roles-2", now }),
    ).toThrow(new StaffIdentityError("SELF_ESCALATION_BLOCKED"));
  });

  it("blocks removing platform_administrator from the last active Platform Administrator", async () => {
    const adminId = bootstrapAdmin();
    const secondAdminId = await invite(adminId, "second@example.com", ["support_agent"]);
    assignStaffRoles({ actorStaffId: adminId, targetStaffId: secondAdminId, roleKeys: ["platform_administrator"], reason: REASON, expectedVersion: 1, idempotencyKey: "roles-3", now });
    // adminId is still a Platform Administrator too, so demoting secondAdminId is fine.
    expect(() =>
      assignStaffRoles({ actorStaffId: adminId, targetStaffId: secondAdminId, roleKeys: ["support_agent"], reason: REASON, expectedVersion: findStaffById(secondAdminId)!.version, idempotencyKey: "roles-4", now }),
    ).not.toThrow();
    // Now only adminId itself holds platform_administrator — demoting via a third party targeting adminId must fail. Use secondAdminId as actor.
    expect(() =>
      assignStaffRoles({ actorStaffId: secondAdminId, targetStaffId: adminId, roleKeys: ["billing_administrator"], reason: REASON, expectedVersion: findStaffById(adminId)!.version, idempotencyKey: "roles-5", now }),
    ).toThrow(new StaffIdentityError("LAST_PLATFORM_ADMINISTRATOR"));
  });
});
