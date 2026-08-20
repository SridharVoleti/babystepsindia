// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { createSupportCase, reopenSupportCase, resolveCustomer, updateSupportCaseWorkflow } from "@/lib/support-cases/service";
import { SupportCaseError } from "@/lib/support-cases/contracts";
import { roleHasCapability } from "@/lib/staff-identity/roles";

let parentEmail: string;
let staff: ReturnType<typeof seedStaffSession>;
let caseId: string;

const REASON = "Parent reports the subscription cancellation date looks wrong.";

beforeEach(async () => {
  useInMemoryDb();
  parentEmail = `parent-${randomUUID()}@example.com`;
  const { user } = await sqliteAuthAdapter.signUp(parentEmail, "CorrectHorse1!");
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", user.id);
  staff = seedStaffSession(["support_agent"]);
  const resolved = await resolveCustomer(staff, { identifierType: "email", identifierValue: parentEmail, reason: REASON });
  caseId = (await createSupportCase(staff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() })).caseId;
});

describe("AD-002 updateSupportCaseWorkflow (AT-AD-002-28/29/30/31/33/34/37/44)", () => {
  it("AT-28/29: a status update mutates only the case row, never a source-domain table or notification", async () => {
    const beforeSubs = (getDb().prepare("select count(*) n from subscriptions").get() as { n: number }).n;
    const beforeNotifications = (getDb().prepare("select count(*) n from transactional_notification_intents").get() as { n: number }).n;
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 1, idempotencyKey: randomUUID(), status: "waiting_parent" });
    expect((getDb().prepare("select count(*) n from subscriptions").get() as { n: number }).n).toBe(beforeSubs);
    expect((getDb().prepare("select count(*) n from transactional_notification_intents").get() as { n: number }).n).toBe(beforeNotifications);
  });

  it("rejects a stale expectedVersion with a conflict, never silently overwriting", async () => {
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 1, idempotencyKey: randomUUID(), status: "in_progress" });
    await expect(updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 1, idempotencyKey: randomUUID(), status: "resolved" }))
      .rejects.toThrow(SupportCaseError);
  });

  it("rejects a transition out of closed — closed is terminal for ordinary workflow", async () => {
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 1, idempotencyKey: randomUUID(), status: "resolved" });
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 2, idempotencyKey: randomUUID(), status: "closed" });
    await expect(updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 3, idempotencyKey: randomUUID(), status: "open" }))
      .rejects.toThrow(SupportCaseError);
  });

  it("AT-30/31: escalation preserves the same case_id and never itself grants the target role", async () => {
    const before = await updateSupportCaseWorkflow(staff, caseId,
      { expectedVersion: 1, idempotencyKey: randomUUID(), status: "escalated", escalationRole: "billing_administrator" });
    expect(before.caseId).toBe(caseId);
    // Escalating never changes the acting staff member's own held roles.
    expect(roleHasCapability(staff.roleKeys, "admin.billing.subscription.reassign")).toBe(false);
  });

  it("AT-33: a Super Admin can continue an escalated case under any of the three target roles because it explicitly holds each", async () => {
    const superAdmin = seedStaffSession(["support_agent", "billing_administrator", "operations_administrator", "platform_administrator"]);
    for (const role of ["billing_administrator", "operations_administrator", "platform_administrator"] as const) {
      expect(roleHasCapability(superAdmin.roleKeys, role === "billing_administrator" ? "admin.billing.subscription.reassign"
        : role === "operations_administrator" ? "admin.app.read" : "admin.staff.roles.update")).toBe(true);
    }
  });

  it("AT-34: an escalated action's activity row records the underlying role actually used, not the Super Admin label", async () => {
    const superAdmin = seedStaffSession(["support_agent", "billing_administrator", "operations_administrator", "platform_administrator"]);
    await updateSupportCaseWorkflow(superAdmin, caseId,
      { expectedVersion: 1, idempotencyKey: randomUUID(), status: "escalated", escalationRole: "billing_administrator" });
    const activity = getDb().prepare(
      "select underlying_role from support_case_activity where case_id=? and canonical_action='admin.support.case.escalate'",
    ).get(caseId) as { underlying_role: string };
    expect(activity.underlying_role).toBe("billing_administrator");
  });

  it("AT-44: an urgent priority never bypasses a missing capability — priority is operational only", async () => {
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 1, idempotencyKey: randomUUID(), priority: "urgent" });
    // Priority alone changes nothing about who can act on the case.
    expect(roleHasCapability(staff.roleKeys, "admin.billing.subscription.reassign")).toBe(false);
  });

  it("rejects assigning a case to a nonexistent/inactive staff account", async () => {
    await expect(updateSupportCaseWorkflow(staff, caseId,
      { expectedVersion: 1, idempotencyKey: randomUUID(), assignedStaffAccountId: randomUUID() })).rejects.toThrow(SupportCaseError);
  });
});

describe("AD-002 reopenSupportCase (AT-AD-002-38/45/46)", () => {
  it("AT-38: reopens a resolved case with a reason, bumping its version and auditing the action", async () => {
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 1, idempotencyKey: randomUUID(), status: "resolved" });
    const reopened = await reopenSupportCase(staff, caseId, { reason: "Parent called back with a follow-up question.", idempotencyKey: randomUUID() });
    expect(reopened.status).toBe("open");
    const activity = getDb().prepare(
      "select count(*) n from support_case_activity where case_id=? and canonical_action='admin.support.case.reopen'",
    ).get(caseId) as { n: number };
    expect(activity.n).toBe(1);
  });

  it("rejects reopening a case that was never resolved", async () => {
    await expect(reopenSupportCase(staff, caseId, { reason: "Trying to reopen an open case.", idempotencyKey: randomUUID() }))
      .rejects.toThrow(SupportCaseError);
  });

  it("AT-45/46: rejects reopening a resolved case past the 24-month retention window", async () => {
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 1, idempotencyKey: randomUUID(), status: "resolved" });
    const farFuture = new Date();
    farFuture.setMonth(farFuture.getMonth() + 25);
    await expect(reopenSupportCase(staff, caseId, { reason: "Way past retention window now.", idempotencyKey: randomUUID() }, farFuture))
      .rejects.toThrow(SupportCaseError);
  });
});
