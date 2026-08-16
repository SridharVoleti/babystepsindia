import { describe, expect, it } from "vitest";
import {
  authorizePrincipalAction, PrincipalAuthorizationError, type LearnerPrincipal,
} from "@/lib/authorization/principals";

const learnerA: LearnerPrincipal = {
  type: "learner", id: "learner-a", learnerId: "learner-a", parentUserId: "parent-1",
  sessionId: "session-1", deviceSessionId: "device-1", credentialId: "cred-1",
};

describe("PC-003 closed-ecosystem child-safety enforcement", () => {
  it("AC1: cross-learner access is denied — learner A cannot be authorized against learner B's resource", () => {
    expect(() => authorizePrincipalAction(learnerA, "learner.home.read", { learnerId: "learner-b" }))
      .toThrow(PrincipalAuthorizationError);
  });

  it("AC1: a learner may only ever act as itself, even for its own allowed action", () => {
    const result = authorizePrincipalAction(learnerA, "learner.home.read", { learnerId: "learner-a" });
    expect(result.allowed).toBe(true);
  });

  it("AC4: a learner principal can never be authorized for any parent_management-mode action — no billing/account mutation path exists", () => {
    const parentOnlyActions = [
      "parent.billing.checkout.create", "parent.billing.subscription.cancel", "parent.profile.update",
      "parent.billing.payment_method.update", "parent.account.delete", "parent.passkeys.manage",
    ] as const;
    for (const action of parentOnlyActions) {
      expect(() => authorizePrincipalAction(learnerA, action, { parentUserId: "parent-1" }))
        .toThrow(PrincipalAuthorizationError);
    }
  });

  it("AC4: a learner principal can never be authorized for any administrator-mode action", () => {
    expect(() => authorizePrincipalAction(learnerA, "admin.account.restore", {})).toThrow(PrincipalAuthorizationError);
  });
});
