import { describe, expect, it } from "vitest";
import { ROLE_CAPABILITIES, isSuperAdminDisplay, roleHasCapability } from "@/lib/staff-identity/roles";
import { validateSensitiveReason } from "@/lib/staff-identity/reason-validation";
import { StaffIdentityError } from "@/lib/staff-identity/errors";

describe("AD-001 role capabilities", () => {
  it("grants Support Agent zero capabilities beyond self-service actions", () => {
    expect(ROLE_CAPABILITIES.support_agent).toHaveLength(0);
    expect(roleHasCapability(["support_agent"], "admin.billing.subscription.reassign")).toBe(false);
    expect(roleHasCapability(["support_agent"], "admin.staff.session_context.read")).toBe(true);
  });

  it("grants Billing Administrator only its named BI-001/BI-005 actions", () => {
    expect(roleHasCapability(["billing_administrator"], "admin.billing.subscription.reassign")).toBe(true);
    expect(roleHasCapability(["billing_administrator"], "admin.billing.refund.create")).toBe(true);
    expect(roleHasCapability(["billing_administrator"], "admin.app.create")).toBe(false);
    expect(roleHasCapability(["billing_administrator"], "admin.staff.roles.update")).toBe(false);
  });

  it("grants Operations Administrator app-registry/deployment actions but no billing or staff-governance actions", () => {
    expect(roleHasCapability(["operations_administrator"], "admin.app.create")).toBe(true);
    expect(roleHasCapability(["operations_administrator"], "admin.deployment.rollback")).toBe(true);
    expect(roleHasCapability(["operations_administrator"], "admin.billing.subscription.reassign")).toBe(false);
    expect(roleHasCapability(["operations_administrator"], "admin.staff.status.update")).toBe(false);
  });

  it("does not let Platform Administrator implicitly inherit Billing/Operations/Support actions (business rules 40-41)", () => {
    expect(roleHasCapability(["platform_administrator"], "admin.account.restore")).toBe(true);
    expect(roleHasCapability(["platform_administrator"], "admin.staff.roles.update")).toBe(true);
    expect(roleHasCapability(["platform_administrator"], "admin.billing.subscription.reassign")).toBe(false);
    expect(roleHasCapability(["platform_administrator"], "admin.app.create")).toBe(false);
  });

  it("unions capabilities across multiple assigned roles (business rule 34)", () => {
    const roles = ["billing_administrator", "operations_administrator"];
    expect(roleHasCapability(roles, "admin.billing.subscription.reassign")).toBe(true);
    expect(roleHasCapability(roles, "admin.app.create")).toBe(true);
    expect(roleHasCapability(roles, "admin.staff.roles.update")).toBe(false);
  });

  it("displays Super Admin only when all four roles are explicitly held (business rules 132-138)", () => {
    expect(isSuperAdminDisplay(["platform_administrator"])).toBe(false);
    expect(
      isSuperAdminDisplay([
        "support_agent",
        "billing_administrator",
        "operations_administrator",
        "platform_administrator",
      ]),
    ).toBe(true);
  });

  it("validates sensitive-action reason length bounds (business rule 66)", () => {
    expect(() => validateSensitiveReason("short")).toThrow(new StaffIdentityError("REASON_INVALID"));
    expect(() => validateSensitiveReason("x".repeat(19))).toThrow(new StaffIdentityError("REASON_INVALID"));
    expect(validateSensitiveReason("x".repeat(20))).toBe("x".repeat(20));
    expect(validateSensitiveReason("x".repeat(500))).toBe("x".repeat(500));
    expect(() => validateSensitiveReason("x".repeat(501))).toThrow(new StaffIdentityError("REASON_INVALID"));
  });

  it("rejects a reason that looks like it contains a secret", () => {
    expect(() =>
      validateSensitiveReason("Refunding because password: hunter2 was shared with the customer accidentally"),
    ).toThrow(new StaffIdentityError("REASON_INVALID"));
  });
});
