import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { activateAuthorizationPolicyBundle, createAuthorizationPolicyBundle } from "@/lib/authorization/policy-bundles";
import { authorizePrincipalAction, PrincipalAuthorizationError, type ParentPrincipal, type LearnerPrincipal } from "@/lib/authorization/principals";
import { generateUiCapabilityHints, isUiCapabilityHintCurrent } from "@/lib/authorization/ui-capabilities";
import { ensureBootstrapPlatformAdmin } from "./helpers/staff-session-fixture";

const now = new Date("2026-08-05T10:00:00.000Z");
const parent: ParentPrincipal = { type: "parent", id: "parent-1", parentUserId: "parent-1",
  sessionId: "session-1", deviceSessionId: "device-1" };

beforeEach(() => useInMemoryDb());

function activatePolicy() {
  createAuthorizationPolicyBundle({ version: "2026.08.1", sourceCommitSha: "a".repeat(40), rules: [
    { actionKey: "parent.profile.read", effect: "allow", principalType: "parent", resourceType: "parent" },
    { actionKey: "parent.profile.update", effect: "deny", principalType: "parent", resourceType: "parent" },
  ] });
  const actor = ensureBootstrapPlatformAdmin(now);
  activateAuthorizationPolicyBundle({ version: "2026.08.1", activatedBy: actor, now });
}

describe("AU-001 short-lived UI capability hints", () => {
  it("derives only active-policy allows and caps lifetime at sixty seconds", () => {
    activatePolicy();
    const hints = generateUiCapabilityHints({ principal: parent,
      candidateActions: ["parent.profile.read", "parent.profile.update", "parent.account.delete"],
      resource: { parentUserId: "parent-1" }, now, ttlSeconds: 600 });
    expect(hints).toEqual({ policyVersion: "2026.08.1", policyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      actions: ["parent.profile.read"], issuedAt: now.toISOString(), expiresAt: "2026-08-05T10:01:00.000Z" });
    expect(isUiCapabilityHintCurrent(hints, new Date("2026-08-05T10:00:59.999Z"))).toBe(true);
    expect(isUiCapabilityHintCurrent(hints, new Date("2026-08-05T10:01:00.000Z"))).toBe(false);
  });

  it("fails closed to an empty, briefly cached hint when policy is unavailable", () => {
    const hints = generateUiCapabilityHints({ principal: parent, candidateActions: ["parent.profile.read"], now });
    expect(hints.actions).toEqual([]);
    expect(hints.policyVersion).toBeNull();
    expect(new Date(hints.expiresAt).getTime() - now.getTime()).toBeLessThanOrEqual(30_000);
  });

  it("contains no actor or resource identifiers", () => {
    activatePolicy();
    const serialized = JSON.stringify(generateUiCapabilityHints({ principal: parent,
      candidateActions: ["parent.profile.read"], resource: { parentUserId: "parent-1" }, now }));
    expect(serialized).not.toContain("parent-1");
    expect(serialized).not.toContain("session-1");
    expect(serialized).not.toContain("device-1");
  });

  it("never converts a forged hint into server authority", () => {
    const learner: LearnerPrincipal = { type: "learner", id: "learner-1", learnerId: "learner-1",
      parentUserId: "parent-1", sessionId: "session-1", deviceSessionId: "device-1", credentialId: "credential-1" };
    const forged = { actions: ["parent.profile.update"], expiresAt: "2099-01-01T00:00:00Z" };
    expect(forged.actions).toContain("parent.profile.update");
    expect(() => authorizePrincipalAction(learner, "parent.profile.update"))
      .toThrowError(new PrincipalAuthorizationError("PRINCIPAL_TYPE_FORBIDDEN"));
  });
});
