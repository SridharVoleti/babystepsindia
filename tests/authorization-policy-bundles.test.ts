import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { ensureBootstrapPlatformAdmin, seedStaffSession } from "./helpers/staff-session-fixture";
import { recordReauthReceipt } from "@/lib/staff-identity/reauth-service";
import {
  AuthorizationPolicyBundleError,
  activateAuthorizationPolicyBundle,
  createAuthorizationPolicyBundle,
  getActiveAuthorizationPolicyBundle,
  getAuthorizationPolicyBundle,
  type AuthorizationPolicyRule,
} from "@/lib/authorization/policy-bundles";

const rules: AuthorizationPolicyRule[] = [
  { actionKey: "parent.account.read", effect: "allow" as const, principalType: "parent", resourceType: "parent" },
  { actionKey: "learner.home.read", effect: "allow" as const, principalType: "learner", resourceType: "learner" },
];

beforeEach(() => useInMemoryDb());

function activate(version: string, actor = ensureBootstrapPlatformAdmin(), now = new Date("2026-08-05T10:00:00Z")) {
  const staffSessionId = crypto.randomUUID();
  recordReauthReceipt({ staffSessionId, staffAccountId: actor, now });
  return activateAuthorizationPolicyBundle({
    version, activatedBy: actor, staffSessionId, reason: "Approved policy release certification", now,
  });
}

describe("AU-001 immutable versioned authorization-policy bundles", () => {
  it("creates a versioned bundle with a deterministic SHA-256 digest", () => {
    const first = createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "a".repeat(40), rules });
    expect(first).toMatchObject({ version: "2026.08.1", sourceCommitSha: "a".repeat(40) });
    expect(first.rules).toEqual(expect.arrayContaining(rules));
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);

    useInMemoryDb();
    const reordered = createAuthorizationPolicyBundle({
      version: "2026.08.1",
      sourceCommitSha: "a".repeat(40),
      rules: [...rules].reverse(),
    });
    expect(reordered.digest).toBe(first.digest);
  });

  it("fails closed until exactly one policy version is active", () => {
    expect(() => getActiveAuthorizationPolicyBundle())
      .toThrowError(new AuthorizationPolicyBundleError("AUTHORIZATION_POLICY_INACTIVE"));
    const bundle = createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "a".repeat(40), rules });
    const actor = ensureBootstrapPlatformAdmin();
    const active = activate(bundle.version, actor);
    expect(active).toMatchObject({ version: bundle.version, digest: bundle.digest });
    expect(getDb().prepare("select count(*) n from authorization_policy_active").get()).toMatchObject({ n: 1 });
    expect(getDb().prepare("select bundle_id,activated_by,activated_at from authorization_policy_activation_history").get())
      .toMatchObject({ bundle_id: bundle.id, activated_by: actor, activated_at: "2026-08-05T10:00:00.000Z" });
  });

  it("atomically switches the singleton pointer and retains append-only history", () => {
    const actor = ensureBootstrapPlatformAdmin();
    createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "a".repeat(40), rules });
    createAuthorizationPolicyBundle({ version: "2026.08.2", sourceCommitSha: "b".repeat(40), rules });
    activate("2026.08.1", actor);
    activate("2026.08.2", actor);
    expect(getActiveAuthorizationPolicyBundle().version).toBe("2026.08.2");
    expect(getDb().prepare("select count(*) n from authorization_policy_active").get()).toMatchObject({ n: 1 });
    expect(getDb().prepare("select count(*) n from authorization_policy_activation_history").get()).toMatchObject({ n: 2 });
    expect(() => getDb().prepare("delete from authorization_policy_activation_history").run()).toThrow(/immutable/i);
    expect(getDb().prepare(`select canonical_action,result,resource_safe_id from staff_audit_log
      where canonical_action='admin.authorization.policy.activate' order by created_at desc limit 1`).get())
      .toMatchObject({ canonical_action: "admin.authorization.policy.activate", result: "success" });
  });

  it("denies non-platform administrators and missing recent reauthentication with audit evidence", () => {
    createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "a".repeat(40), rules });
    const operations = seedStaffSession(["operations_administrator"], { now: new Date("2026-08-05T10:00:00Z") });
    expect(() => activateAuthorizationPolicyBundle({ version: "2026.08.1", activatedBy: operations.staffAccountId,
      staffSessionId: operations.sessionId, reason: "Unauthorized policy activation attempt" }))
      .toThrowError(new AuthorizationPolicyBundleError("POLICY_ACTIVATION_FORBIDDEN"));
    const admin = ensureBootstrapPlatformAdmin();
    expect(() => activateAuthorizationPolicyBundle({ version: "2026.08.1", activatedBy: admin,
      staffSessionId: "session-without-reauth", reason: "Policy activation without recent authentication" }))
      .toThrowError(new AuthorizationPolicyBundleError("POLICY_ACTIVATION_REAUTH_REQUIRED"));
    expect(getDb().prepare(`select count(*) n from staff_audit_log
      where canonical_action='admin.authorization.policy.activate' and result='denied'`).get()).toMatchObject({ n: 2 });
    expect(() => getActiveAuthorizationPolicyBundle())
      .toThrowError(new AuthorizationPolicyBundleError("AUTHORIZATION_POLICY_INACTIVE"));
  });

  it("rolls back the pointer when activation history cannot be recorded", () => {
    const actor = ensureBootstrapPlatformAdmin();
    createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "a".repeat(40), rules });
    const second = createAuthorizationPolicyBundle({ version: "2026.08.2", sourceCommitSha: "b".repeat(40), rules });
    activate("2026.08.1", actor);
    getDb().exec(`create trigger test_reject_second_activation before insert on authorization_policy_activation_history
      when new.bundle_id='${second.id}' begin select raise(abort,'simulated activation history failure'); end`);
    expect(() => activate("2026.08.2", actor)).toThrow(/simulated/);
    expect(getActiveAuthorizationPolicyBundle().version).toBe("2026.08.1");
    expect(getDb().prepare("select count(*) n from authorization_policy_activation_history").get()).toMatchObject({ n: 1 });
    expect(getDb().prepare(`select count(*) n from staff_audit_log
      where canonical_action='admin.authorization.policy.activate' and result='failure'`).get()).toMatchObject({ n: 1 });
  });

  it("rejects replacement of an existing version, even with different content", () => {
    createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "a".repeat(40), rules });
    expect(() => createAuthorizationPolicyBundle({
      version: "2026.08.1",
      sourceCommitSha: "b".repeat(40),
      rules: rules.slice(0, 1),
    })).toThrowError(new AuthorizationPolicyBundleError("POLICY_BUNDLE_VERSION_EXISTS"));
  });

  it("enforces immutability at the database boundary", () => {
    const bundle = createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "a".repeat(40), rules });
    expect(() => getDb().prepare("update authorization_policy_bundles set source_commit_sha=? where id=?")
      .run("b".repeat(40), bundle.id)).toThrow(/immutable/i);
    expect(() => getDb().prepare("delete from authorization_policy_bundles where id=?").run(bundle.id)).toThrow(/immutable/i);
  });

  it("fails closed when persisted bundle content no longer matches its digest", () => {
    const bundle = createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "a".repeat(40), rules });
    getDb().exec("drop trigger authorization_policy_bundles_no_update");
    getDb().prepare("update authorization_policy_bundles set policy_json=? where id=?").run("[]", bundle.id);
    expect(() => getAuthorizationPolicyBundle("2026.08.1"))
      .toThrowError(new AuthorizationPolicyBundleError("POLICY_BUNDLE_INTEGRITY_FAILED"));
  });

  it("rejects malformed versions, commits, duplicate actions, and unknown actions", () => {
    expect(() => createAuthorizationPolicyBundle({ version: "latest", sourceCommitSha: "a".repeat(40), rules }))
      .toThrowError(new AuthorizationPolicyBundleError("POLICY_BUNDLE_INVALID"));
    expect(() => createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "nope", rules }))
      .toThrowError(new AuthorizationPolicyBundleError("POLICY_BUNDLE_INVALID"));
    expect(() => createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "a".repeat(40), rules: [rules[0], rules[0]] }))
      .toThrowError(new AuthorizationPolicyBundleError("POLICY_BUNDLE_INVALID"));
    expect(() => createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "a".repeat(40), rules: [
      { ...rules[0], actionKey: "browser.chosen.action" },
    ] })) .toThrowError(new AuthorizationPolicyBundleError("POLICY_BUNDLE_INVALID"));
  });
});
