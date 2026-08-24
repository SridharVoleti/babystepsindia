// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getNotificationTypeDefinition, NOTIFICATION_TYPE_REGISTRY, validateSafeVariables } from
  "@/lib/notifications/contracts";
import { resolveCurrentVerifiedParentEmail } from "@/lib/notifications/recipient";
import { NotificationTemplateError, renderNotificationTemplate } from "@/lib/notifications/templates";

beforeEach(() => { useInMemoryDb(); });

describe("NT-001 notification type registry (AT-NT-001-09/10/12)", () => {
  it("every V1 type is mandatory and declares a source domain + template version", () => {
    expect(Object.keys(NOTIFICATION_TYPE_REGISTRY)).toHaveLength(11);
    for (const definition of Object.values(NOTIFICATION_TYPE_REGISTRY)) {
      expect(definition.mandatory).toBe(true);
      expect(definition.allowedSourceDomain.length).toBeGreaterThan(0);
      expect(definition.templateVersion).toBe("v1");
    }
  });

  it("returns undefined for an unknown notification type", () => {
    expect(getNotificationTypeDefinition("not_a_real_type")).toBeUndefined();
  });

  it("AT-NT-001-10: rejects an unexpected/unknown variable", () => {
    const definition = getNotificationTypeDefinition("billing_payment_recovered")!;
    const error = validateSafeVariables(definition, { subscriptionLabel: "Plan", cardNumber: "4111" });
    expect(error).toBe("UNKNOWN_VARIABLE:cardNumber");
  });

  it("rejects a missing required variable", () => {
    const definition = getNotificationTypeDefinition("billing_payment_recovered")!;
    expect(validateSafeVariables(definition, {})).toBe("MISSING_VARIABLE:subscriptionLabel");
  });

  it("rejects a required variable with the wrong type", () => {
    const definition = getNotificationTypeDefinition("billing_renewal_reminder")!;
    const error = validateSafeVariables(definition,
      { subscriptionLabel: "Plan", renewalDate: "2026-09-01", amount: "not-a-number", currency: "INR" });
    expect(error).toBe("INVALID_VARIABLE:amount");
  });

  it("accepts a fully valid variable set", () => {
    const definition = getNotificationTypeDefinition("billing_renewal_reminder")!;
    const error = validateSafeVariables(definition,
      { subscriptionLabel: "Plan", renewalDate: "2026-09-01", amount: 499, currency: "INR" });
    expect(error).toBeNull();
  });
});

describe("NT-001 template rendering (AT-NT-001-09/12/13/26 rendering half)", () => {
  it("AT-NT-001-09: rejects an unknown notification type before render", async () => {
    await expect(renderNotificationTemplate("not_a_real_type", "v1", {})).rejects.toThrow(NotificationTemplateError);
  });

  it("rejects an unknown template version before render", async () => {
    await expect(renderNotificationTemplate("account_password_changed", "v99", {})).rejects.toThrow(NotificationTemplateError);
  });

  it("rejects rendering with a missing required variable", async () => {
    await expect(renderNotificationTemplate("billing_grace_started", "v1", {})).rejects.toThrow(NotificationTemplateError);
  });

  it("renders deterministically for the same type/version/variables and never emits raw HTML from input", () => {
    const vars = { subscriptionLabel: "<script>alert(1)</script>", accessEndsAt: "2026-09-01" };
    const first = renderNotificationTemplate("subscription_cancellation_scheduled", "v1", vars);
    const second = renderNotificationTemplate("subscription_cancellation_scheduled", "v1", vars);
    expect(first).toEqual(second);
    expect(first.html).not.toContain("<script>");
    expect(first.html).toContain("&lt;script&gt;");
  });

  it("every rendered email includes the neutral footer, not marketing unsubscribe copy", () => {
    const rendered = renderNotificationTemplate("account_email_changed", "v1", {});
    expect(rendered.text).toContain("Babysteps");
    expect(rendered.html.toLowerCase()).not.toContain("unsubscribe");
  });
});

describe("NT-001 recipient resolution (AT-NT-001-06/07/28)", () => {
  let parentId: string;

  beforeEach(async () => {
    const { user } = await sqliteAuthAdapter.signUp(`nt001-${randomUUID()}@example.com`, "CorrectHorse1!");
    parentId = user.id;
  });

  it("returns null when the parent's email is not yet verified (AT-NT-001-28: blocked_recipient)", async () => {
    expect(await resolveCurrentVerifiedParentEmail(parentId)).toBeNull();
  });

  it("returns null for an unknown parent id", async () => {
    expect(await resolveCurrentVerifiedParentEmail(randomUUID())).toBeNull();
  });

  it("returns the current verified email once verified", async () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    const resolved = await resolveCurrentVerifiedParentEmail(parentId);
    expect(resolved?.parentId).toBe(parentId);
    expect(resolved?.email).toContain("nt001-");
  });

  it("AT-NT-001-06/07: resolves the newest verified email, never a pending replacement", async () => {
    getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
    getDb().prepare(
      "insert into email_change_requests (id, parent_user_id, old_email, new_email, token_hash, status, expires_at) "
      + "values (?, ?, 'old@example.com', 'pending-new@example.com', 'hash', 'pending', ?)",
    ).run(randomUUID(), parentId, "2026-09-01T00:00:00.000Z");
    const resolved = await resolveCurrentVerifiedParentEmail(parentId);
    expect(resolved?.email).not.toBe("pending-new@example.com");
  });
});
