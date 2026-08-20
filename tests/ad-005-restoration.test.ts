// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { restoreAccountViaGovernance } from "@/lib/platform-governance/restoration";
import { PlatformGovernanceError } from "@/lib/platform-governance/contracts";

const REASON = "Deletion confirmed accidental after the parent contacted support.";

let staff: ReturnType<typeof seedStaffSession>;

beforeEach(() => {
  useInMemoryDb();
  staff = seedStaffSession(["platform_administrator"]);
});

async function seedDeletedParent() {
  const { user } = await sqliteAuthAdapter.signUp(`parent-${randomUUID()}@example.com`, "CorrectHorse1!");
  getDb().prepare("update profiles set account_status='deleted' where id=?").run(user.id);
  return user.id;
}

describe("AD-005 restoreAccountViaGovernance (AT-AD-005-29/30/31/32)", () => {
  it("AT-29/30: restores a deleted account given a governance reference, reason, and matching version", async () => {
    const parentId = await seedDeletedParent();
    const result = await restoreAccountViaGovernance(staff, {
      parentId, reason: REASON, expectedVersion: 1, idempotencyKey: randomUUID(), governanceReference: "incident-42",
    });
    expect(result.parentId).toBe(parentId);
    const row = getDb().prepare("select account_status, version from profiles where id=?").get(parentId) as
      { account_status: string; version: number };
    expect(row.account_status).toBe("active");
    expect(row.version).toBe(2);
  });

  it("requires either a case ID or a governance reference — neither is rejected", async () => {
    const parentId = await seedDeletedParent();
    await expect(restoreAccountViaGovernance(staff, {
      parentId, reason: REASON, expectedVersion: 1, idempotencyKey: randomUUID(),
    })).rejects.toThrow(PlatformGovernanceError);
  });

  it("a stale expectedVersion is rejected as a conflict, never silently overwritten", async () => {
    const parentId = await seedDeletedParent();
    await expect(restoreAccountViaGovernance(staff, {
      parentId, reason: REASON, expectedVersion: 99, idempotencyKey: randomUUID(), governanceReference: "incident-42",
    })).rejects.toThrow(PlatformGovernanceError);
  });

  it("AT-31: never restores an account that isn't actually deleted", async () => {
    const { user } = await sqliteAuthAdapter.signUp(`parent-${randomUUID()}@example.com`, "CorrectHorse1!");
    await expect(restoreAccountViaGovernance(staff, {
      parentId: user.id, reason: REASON, expectedVersion: 1, idempotencyKey: randomUUID(), governanceReference: "incident-42",
    })).rejects.toThrow(PlatformGovernanceError);
  });

  it("a nonexistent parent fails safely", async () => {
    await expect(restoreAccountViaGovernance(staff, {
      parentId: randomUUID(), reason: REASON, expectedVersion: 1, idempotencyKey: randomUUID(), governanceReference: "incident-42",
    })).rejects.toThrow(PlatformGovernanceError);
  });

  it("rejects a case reference that does not correspond to a real support case", async () => {
    const parentId = await seedDeletedParent();
    await expect(restoreAccountViaGovernance(staff, {
      parentId, reason: REASON, expectedVersion: 1, idempotencyKey: randomUUID(), caseId: randomUUID(),
    })).rejects.toThrow(PlatformGovernanceError);
  });

  it("replaying the same idempotencyKey returns the same result, never restoring twice", async () => {
    const parentId = await seedDeletedParent();
    const idempotencyKey = randomUUID();
    const first = await restoreAccountViaGovernance(staff, {
      parentId, reason: REASON, expectedVersion: 1, idempotencyKey, governanceReference: "incident-42",
    });
    const second = await restoreAccountViaGovernance(staff, {
      parentId, reason: REASON, expectedVersion: 1, idempotencyKey, governanceReference: "incident-42",
    });
    expect(second).toEqual(first);
    const row = getDb().prepare("select version from profiles where id=?").get(parentId) as { version: number };
    expect(row.version).toBe(2);
  });
});
