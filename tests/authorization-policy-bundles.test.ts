import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { resetDbClientForTests } from "@/lib/db-client";
import { generateUiCapabilityHints } from "@/lib/authorization/ui-capabilities";
import { ensureBootstrapPlatformAdmin } from "./helpers/staff-session-fixture";
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
    const active = activateAuthorizationPolicyBundle({ version: bundle.version, activatedBy: actor, now: new Date("2026-08-05T10:00:00Z") });
    expect(active).toMatchObject({ version: bundle.version, digest: bundle.digest });
    expect(getDb().prepare("select count(*) n from authorization_policy_active").get()).toMatchObject({ n: 1 });
    expect(getDb().prepare("select bundle_id,activated_by,activated_at from authorization_policy_activation_history").get())
      .toMatchObject({ bundle_id: bundle.id, activated_by: actor, activated_at: "2026-08-05T10:00:00.000Z" });
  });

  it("atomically switches the singleton pointer and retains append-only history", () => {
    const actor = ensureBootstrapPlatformAdmin();
    createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "a".repeat(40), rules });
    createAuthorizationPolicyBundle({ version: "2026.08.2", sourceCommitSha: "b".repeat(40), rules });
    activateAuthorizationPolicyBundle({ version: "2026.08.1", activatedBy: actor });
    activateAuthorizationPolicyBundle({ version: "2026.08.2", activatedBy: actor });
    expect(getActiveAuthorizationPolicyBundle().version).toBe("2026.08.2");
    expect(getDb().prepare("select count(*) n from authorization_policy_active").get()).toMatchObject({ n: 1 });
    expect(getDb().prepare("select count(*) n from authorization_policy_activation_history").get()).toMatchObject({ n: 2 });
    expect(() => getDb().prepare("delete from authorization_policy_activation_history").run()).toThrow(/immutable/i);
  });

  it("rolls back the pointer when activation history cannot be recorded", () => {
    const actor = ensureBootstrapPlatformAdmin();
    createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "a".repeat(40), rules });
    const second = createAuthorizationPolicyBundle({ version: "2026.08.2", sourceCommitSha: "b".repeat(40), rules });
    activateAuthorizationPolicyBundle({ version: "2026.08.1", activatedBy: actor });
    getDb().exec(`create trigger test_reject_second_activation before insert on authorization_policy_activation_history
      when new.bundle_id='${second.id}' begin select raise(abort,'simulated activation history failure'); end`);
    expect(() => activateAuthorizationPolicyBundle({ version: "2026.08.2", activatedBy: actor })).toThrow(/simulated/);
    expect(getActiveAuthorizationPolicyBundle().version).toBe("2026.08.1");
    expect(getDb().prepare("select count(*) n from authorization_policy_activation_history").get()).toMatchObject({ n: 1 });
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

  it("degrades to AUTHORIZATION_POLICY_INACTIVE on the Postgres backend instead of crashing in getDb()", () => {
    // Regression: this module still uses the sync better-sqlite3 client and
    // has no Postgres path. On a deployed (Postgres) env, getDb() throws
    // `ENOENT: mkdir './data'`, which 500'd /v1/learner-home and
    // /v1/learner-selection through generateUiCapabilityHints.
    const previous = process.env.SUPABASE_DB_URL;
    process.env.SUPABASE_DB_URL = "postgres://unused-in-this-test/db";
    resetDbClientForTests();
    try {
      expect(() => getActiveAuthorizationPolicyBundle())
        .toThrowError(new AuthorizationPolicyBundleError("AUTHORIZATION_POLICY_INACTIVE"));
      const hints = generateUiCapabilityHints({
        principal: { type: "learner", id: "l1", learnerId: "l1", parentUserId: "p1",
          sessionId: "s1", deviceSessionId: "d1", credentialId: "c1" },
        candidateActions: ["learner.session.start"], resource: { learnerId: "l1" },
        now: new Date("2026-08-05T10:00:00Z") });
      expect(hints).toMatchObject({ policyVersion: null, policyDigest: null, actions: [] });
    } finally {
      if (previous === undefined) delete process.env.SUPABASE_DB_URL;
      else process.env.SUPABASE_DB_URL = previous;
      resetDbClientForTests();
    }
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
