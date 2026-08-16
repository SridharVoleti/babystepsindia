// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { resetRateLimitsForTests } from "@/lib/auth/rate-limit";
import {
  issueNormalRecoverySession, issueBreakGlassRecoverySession, consumeRecoverySessionWithPassword,
  completeRecoveryEnrollment,
} from "@/lib/platform-governance/recovery-sessions";
import { PlatformGovernanceError } from "@/lib/platform-governance/contracts";
import { getRecoveryCodeStatus, rotateRecoveryCodes } from "@/lib/platform-governance/recovery-codes";

const REASON = "Target lost their phone with the only passkey enrolled on it.";

function email() {
  return `staff-${randomUUID()}@example.com`;
}

beforeEach(() => {
  useInMemoryDb();
  resetRateLimitsForTests();
  process.env.AUTH_SECRET = "test-secret-at-least-32-bytes-long!!";
});

describe("AD-005 issueNormalRecoverySession (AT-AD-005-11/12/17)", () => {
  it("AT-49: a different active Platform Administrator may issue a target-bound 30-minute session", () => {
    const issuer = seedStaffSession(["platform_administrator"]);
    const target = seedStaffSession(["support_agent"]);
    const session = issueNormalRecoverySession(issuer, { targetStaffId: target.staffAccountId, reason: REASON });
    expect(session.targetStaffId).toBe(target.staffAccountId);
    const row = getDb().prepare("select method from staff_recovery_sessions where id=?").get(session.recoverySessionId) as
      { method: string };
    expect(row.method).toBe("normal");
  });

  it("AT-49: a Platform Administrator cannot issue a recovery session for themselves", () => {
    const issuer = seedStaffSession(["platform_administrator"]);
    expect(() => issueNormalRecoverySession(issuer, { targetStaffId: issuer.staffAccountId, reason: REASON }))
      .toThrow(PlatformGovernanceError);
  });

  it("a fresh session supersedes any prior outstanding session for the same target", () => {
    const issuer = seedStaffSession(["platform_administrator"]);
    const target = seedStaffSession(["support_agent"]);
    const first = issueNormalRecoverySession(issuer, { targetStaffId: target.staffAccountId, reason: REASON });
    const second = issueNormalRecoverySession(issuer, { targetStaffId: target.staffAccountId, reason: REASON });
    const firstRow = getDb().prepare("select consumed_at from staff_recovery_sessions where id=?").get(first.recoverySessionId) as
      { consumed_at: string | null };
    expect(firstRow.consumed_at).not.toBeNull();
    const secondRow = getDb().prepare("select consumed_at from staff_recovery_sessions where id=?").get(second.recoverySessionId) as
      { consumed_at: string | null };
    expect(secondRow.consumed_at).toBeNull();
  });
});

describe("AD-005 issueBreakGlassRecoverySession (AT-AD-005-18/19/22-25)", () => {
  it("AT-18: allowed for the sole active Platform Administrator with a valid unused code", async () => {
    const password = "CorrectHorse-Battery-1!";
    const adminEmail = email();
    const admin = seedStaffSession(["platform_administrator"], { password, email: adminEmail });
    // openDb() auto-seeds a bootstrap Platform Administrator on every fresh
    // DB (src/lib/staff-identity/bootstrap.ts) — suspend it so this test's
    // admin is genuinely the sole ACTIVE one, matching what "sole" means to
    // countActivePlatformAdministrators (status='active' only).
    getDb().prepare("update staff_accounts set status='suspended' where id<>?").run(admin.staffAccountId);
    const rotated = rotateRecoveryCodes(admin.staffAccountId);
    expect(rotated.codes.length).toBeGreaterThanOrEqual(2);

    const result = await issueBreakGlassRecoverySession({ email: adminEmail, password, recoveryCode: rotated.codes[0]! });
    expect(result.pendingToken).toBeTruthy();
    const status = getRecoveryCodeStatus();
    expect(status.activeCount).toBe(rotated.codes.length - 1);
  });

  it("AT-25: denies break-glass when a different active Platform Administrator already exists", async () => {
    const password = "CorrectHorse-Battery-2!";
    const adminEmail = email();
    const admin = seedStaffSession(["platform_administrator"], { password, email: adminEmail });
    seedStaffSession(["platform_administrator"]);
    const rotated = rotateRecoveryCodes(admin.staffAccountId);
    await expect(issueBreakGlassRecoverySession({ email: adminEmail, password, recoveryCode: rotated.codes[0]! }))
      .rejects.toThrow(PlatformGovernanceError);
  });

  it("AT-19/22: rejects an invalid or already-used recovery code", async () => {
    const password = "CorrectHorse-Battery-3!";
    const adminEmail = email();
    seedStaffSession(["platform_administrator"], { password, email: adminEmail });
    await expect(issueBreakGlassRecoverySession({ email: adminEmail, password, recoveryCode: "NOT-A-REAL-CODE" }))
      .rejects.toThrow(PlatformGovernanceError);
  });

  it("AT-24: a revoked staff account cannot use break-glass even with a valid code", async () => {
    const password = "CorrectHorse-Battery-4!";
    const adminEmail = email();
    const admin = seedStaffSession(["platform_administrator"], { password, email: adminEmail });
    const rotated = rotateRecoveryCodes(admin.staffAccountId);
    getDb().prepare("update staff_accounts set status='revoked' where id=?").run(admin.staffAccountId);
    await expect(issueBreakGlassRecoverySession({ email: adminEmail, password, recoveryCode: rotated.codes[0]! }))
      .rejects.toThrow(PlatformGovernanceError);
  });
});

describe("AD-005 consumeRecoverySessionWithPassword (rule 42)", () => {
  it("exchanges a valid normal-recovery session for a pendingToken only after the target's own password", async () => {
    const password = "TargetOwnPassword-1!";
    const issuer = seedStaffSession(["platform_administrator"]);
    const targetEmail = email();
    const target = seedStaffSession(["support_agent"], { password, email: targetEmail });
    issueNormalRecoverySession(issuer, { targetStaffId: target.staffAccountId, reason: REASON });
    const result = await consumeRecoverySessionWithPassword({ email: targetEmail, password });
    expect(result.pendingToken).toBeTruthy();
  });

  it("fails when no active recovery session exists for the target", async () => {
    const password = "TargetOwnPassword-2!";
    const targetEmail = email();
    seedStaffSession(["support_agent"], { password, email: targetEmail });
    await expect(consumeRecoverySessionWithPassword({ email: targetEmail, password }))
      .rejects.toThrow(PlatformGovernanceError);
  });
});

describe("AD-005 completeRecoveryEnrollment (AT-AD-005-14/15/26)", () => {
  it("consumes the session and bumps authorization_generation, invalidating other live sessions", () => {
    const issuer = seedStaffSession(["platform_administrator"]);
    const target = seedStaffSession(["support_agent"]);
    const before = getDb().prepare("select authorization_generation from staff_accounts where id=?").get(target.staffAccountId) as
      { authorization_generation: number };
    const session = issueNormalRecoverySession(issuer, { targetStaffId: target.staffAccountId, reason: REASON });
    completeRecoveryEnrollment({ recoverySessionId: session.recoverySessionId, staffAccountId: target.staffAccountId });
    const after = getDb().prepare("select authorization_generation from staff_accounts where id=?").get(target.staffAccountId) as
      { authorization_generation: number };
    expect(after.authorization_generation).toBe(before.authorization_generation + 1);
    const row = getDb().prepare("select consumed_at from staff_recovery_sessions where id=?").get(session.recoverySessionId) as
      { consumed_at: string | null };
    expect(row.consumed_at).not.toBeNull();
  });

  it("a single-use session cannot be completed twice", () => {
    const issuer = seedStaffSession(["platform_administrator"]);
    const target = seedStaffSession(["support_agent"]);
    const session = issueNormalRecoverySession(issuer, { targetStaffId: target.staffAccountId, reason: REASON });
    completeRecoveryEnrollment({ recoverySessionId: session.recoverySessionId, staffAccountId: target.staffAccountId });
    expect(() => completeRecoveryEnrollment({ recoverySessionId: session.recoverySessionId, staffAccountId: target.staffAccountId }))
      .toThrow(PlatformGovernanceError);
  });
});
