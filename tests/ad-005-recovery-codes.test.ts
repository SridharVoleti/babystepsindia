// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { ensureBootstrapPlatformAdmin } from "./helpers/staff-session-fixture";
import { bootstrapRecoveryCodes, consumeRecoveryCode, getRecoveryCodeStatus, rotateRecoveryCodes } from "@/lib/platform-governance/recovery-codes";

let staffId: string;

beforeEach(() => {
  useInMemoryDb();
  staffId = ensureBootstrapPlatformAdmin();
});

describe("AD-005 bootstrapRecoveryCodes (rule 51)", () => {
  it("openDb()'s own bootstrap already seeded at least two codes without recursing/hanging", async () => {
    const status = await getRecoveryCodeStatus();
    expect(status.activeCount).toBeGreaterThanOrEqual(2);
  });

  it("is a no-op once codes already exist — never issues a second free batch", async () => {
    const before = await getRecoveryCodeStatus();
    const result = bootstrapRecoveryCodes(getDb());
    expect(result).toHaveLength(0);
    expect((await getRecoveryCodeStatus()).activeCount).toBe(before.activeCount);
  });
});

describe("AD-005 rotateRecoveryCodes (AT-AD-005-27/28)", () => {
  it("AT-27: invalidates every previously active code", async () => {
    const before = getDb().prepare("select id from platform_recovery_codes where status='active'").all() as { id: string }[];
    await rotateRecoveryCodes(staffId);
    const revoked = getDb().prepare("select count(*) as n from platform_recovery_codes where status='revoked'").get() as { n: number };
    expect(revoked.n).toBe(before.length);
  });

  it("AT-28: new codes are shown once as plaintext here and never derivable from storage afterward", async () => {
    const rotated = await rotateRecoveryCodes(staffId);
    expect(rotated.codes.length).toBeGreaterThanOrEqual(2);
    for (const code of rotated.codes) {
      expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    }
    const stored = getDb().prepare("select verifier_hash from platform_recovery_codes where status='active'").all() as
      { verifier_hash: string }[];
    for (const row of stored) {
      expect(rotated.codes).not.toContain(row.verifier_hash);
    }
  });

  it("bumps the generation and a used/revoked code from the old generation can never be reused", async () => {
    const first = await rotateRecoveryCodes(staffId);
    const oldCode = first.codes[0]!;
    const second = await rotateRecoveryCodes(staffId);
    expect(second.generation).toBe(first.generation + 1);
    expect(await consumeRecoveryCode(oldCode, staffId, new Date())).toBe(false);
  });
});

describe("AD-005 consumeRecoveryCode (rules 55-56, 58, 64)", () => {
  it("a valid unused code is consumed exactly once — a second attempt with the same code fails", async () => {
    const rotated = await rotateRecoveryCodes(staffId);
    const code = rotated.codes[0]!;
    expect(await consumeRecoveryCode(code, staffId, new Date())).toBe(true);
    expect(await consumeRecoveryCode(code, staffId, new Date())).toBe(false);
  });

  it("an unrecognized code is rejected", async () => {
    expect(await consumeRecoveryCode("NOT-A-REAL-CODE-AT-ALL", staffId, new Date())).toBe(false);
  });
});
