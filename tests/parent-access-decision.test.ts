import { describe, expect, it } from "vitest";
import { parentAccessDecision } from "@/lib/auth/parent-profile";

const NOW_SECONDS = Math.floor(Date.now() / 1000);

describe("parentAccessDecision — session revocation (IA-003)", () => {
  it("denies a session issued before auth_revoked_before, even for an active account", () => {
    const revokedAtIso = new Date((NOW_SECONDS - 60) * 1000).toISOString(); // revoked 60s ago
    const sessionIssuedAt = NOW_SECONDS - 3600; // issued an hour ago — before revocation

    const result = parentAccessDecision({
      emailVerified: true,
      profile: { account_status: "active", auth_revoked_before: revokedAtIso },
      sessionIssuedAt,
    });

    expect(result).toEqual({ allowed: false, code: "SESSION_REVOKED" });
  });

  it("allows a session issued after auth_revoked_before (fresh login post-restore)", () => {
    const revokedAtIso = new Date((NOW_SECONDS - 3600) * 1000).toISOString(); // revoked an hour ago
    const sessionIssuedAt = NOW_SECONDS - 10; // fresh login just now

    const result = parentAccessDecision({
      emailVerified: true,
      profile: { account_status: "active", auth_revoked_before: revokedAtIso },
      sessionIssuedAt,
    });

    expect(result).toEqual({ allowed: true, code: null });
  });

  it("allows access when auth_revoked_before is null regardless of session age", () => {
    const result = parentAccessDecision({
      emailVerified: true,
      profile: { account_status: "active", auth_revoked_before: null },
      sessionIssuedAt: NOW_SECONDS - 1_000_000,
    });

    expect(result).toEqual({ allowed: true, code: null });
  });

  it("still denies ACCOUNT_DELETED ahead of the revocation check", () => {
    const result = parentAccessDecision({
      emailVerified: true,
      profile: { account_status: "deleted", auth_revoked_before: null },
      sessionIssuedAt: NOW_SECONDS,
    });

    expect(result).toEqual({ allowed: false, code: "ACCOUNT_DELETED" });
  });

  it("treats a missing sessionIssuedAt as not revoked (backward compatible)", () => {
    const revokedAtIso = new Date().toISOString();
    const result = parentAccessDecision({
      emailVerified: true,
      profile: { account_status: "active", auth_revoked_before: revokedAtIso },
    });
    expect(result).toEqual({ allowed: true, code: null });
  });
});
