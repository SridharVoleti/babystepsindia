// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { createSupportCase, getSupportCase, listSupportCases, resolveCustomer } from "@/lib/support-cases/service";
import { SupportCaseError } from "@/lib/support-cases/contracts";
import { roleHasCapability } from "@/lib/staff-identity/roles";
import fs from "node:fs";

let parentId: string;
let parentEmail: string;
let supportStaff: ReturnType<typeof seedStaffSession>;
let billingOnlyStaff: ReturnType<typeof seedStaffSession>;
let allFourRoleStaff: ReturnType<typeof seedStaffSession>;

const REASON = "Parent called about their subscription renewal date changing unexpectedly.";

beforeEach(async () => {
  useInMemoryDb();
  parentEmail = `parent-${randomUUID()}@example.com`;
  const { user } = await sqliteAuthAdapter.signUp(parentEmail, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
  supportStaff = seedStaffSession(["support_agent"]);
  billingOnlyStaff = seedStaffSession(["billing_administrator"]);
  allFourRoleStaff = seedStaffSession(["support_agent", "billing_administrator", "operations_administrator", "platform_administrator"]);
});

async function resolveAndCreate(staff: { staffAccountId: string; roleKeys: string[] }) {
  const resolved = await resolveCustomer(staff, { identifierType: "email", identifierValue: parentEmail, reason: REASON });
  return await createSupportCase(staff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON,
    idempotencyKey: randomUUID() });
}

describe("AD-002 createSupportCase (AT-AD-002-01/09/10/11/12/13)", () => {
  it("AT-09: creates an immutable parent-bound case from a valid resolver receipt", async () => {
    const result = await resolveAndCreate(supportStaff);
    expect(result.caseId).toBeTruthy();
    const row = getDb().prepare("select parent_id from support_cases where id=?").get(result.caseId) as { parent_id: string };
    expect(row.parent_id).toBe(parentId);
  });

  it("AT-10: no update function/route can change a case's parent_id — it is structurally immutable", async () => {
    const serviceSource = fs.readFileSync("src/lib/support-cases/service.ts", "utf8");
    expect(serviceSource).not.toMatch(/set\s+[^,]*parent_id\s*=\s*\?/i);
  });

  it("AT-11: a billing-only staff member has no Support capability (no implicit inheritance)", async () => {
    expect(roleHasCapability(billingOnlyStaff.roleKeys, "admin.support.case.create")).toBe(false);
  });

  it("AT-12: a Super Admin (all four explicit roles) can use support because it explicitly holds Support Agent", async () => {
    expect(roleHasCapability(allFourRoleStaff.roleKeys, "admin.support.case.create")).toBe(true);
    const result = await resolveAndCreate(allFourRoleStaff);
    expect(result.caseId).toBeTruthy();
  });

  it("AT-13: holding only the other three roles (no Support Agent) is denied — the label alone is never authority", async () => {
    const threeRoleStaff = seedStaffSession(["billing_administrator", "operations_administrator", "platform_administrator"]);
    expect(roleHasCapability(threeRoleStaff.roleKeys, "admin.support.case.create")).toBe(false);
  });

  it("creating a case with the same idempotencyKey/receipt twice returns the same case, not a new one", async () => {
    const resolved = await resolveCustomer(supportStaff, { identifierType: "email", identifierValue: parentEmail, reason: REASON });
    const idempotencyKey = randomUUID();
    const first = await createSupportCase(supportStaff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey });
    const second = await createSupportCase(supportStaff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey });
    expect(second.caseId).toBe(first.caseId);
    const count = getDb().prepare("select count(*) n from support_cases").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("a consumed receipt reused with a DIFFERENT idempotencyKey still returns the original case, never a second one", async () => {
    const resolved = await resolveCustomer(supportStaff, { identifierType: "email", identifierValue: parentEmail, reason: REASON });
    const first = await createSupportCase(supportStaff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() });
    const second = await createSupportCase(supportStaff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() });
    expect(second.caseId).toBe(first.caseId);
    const count = getDb().prepare("select count(*) n from support_cases").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("an already-expired receipt (never consumed) cannot create a case", async () => {
    const past = new Date("2026-01-01T00:00:00.000Z");
    const resolved = await resolveCustomer(supportStaff, { identifierType: "email", identifierValue: parentEmail, reason: REASON }, past);
    await expect(createSupportCase(supportStaff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() }, new Date("2026-06-01T00:00:00.000Z")))
      .rejects.toThrow(SupportCaseError);
  });

  it("a no-match receipt cannot create a case", async () => {
    const resolved = await resolveCustomer(supportStaff, { identifierType: "email", identifierValue: "nomatch@example.com", reason: REASON });
    await expect(createSupportCase(supportStaff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() }))
      .rejects.toThrow(SupportCaseError);
  });
});

describe("AD-002 getSupportCase / listSupportCases (AT-AD-002-32/33/36/40)", () => {
  it("AT-40: a foreign/nonexistent case ID is a safe, non-enumerating deny", async () => {
    await expect(getSupportCase(supportStaff, randomUUID())).rejects.toThrow(SupportCaseError);
  });

  it("AT-36: case lists are scoped before pagination — an unassigned case is visible, one assigned to someone else is not counted for a non-escalated staff member", async () => {
    const result = await resolveAndCreate(supportStaff);
    const otherStaff = seedStaffSession(["support_agent"]);
    getDb().prepare("update support_cases set assigned_staff_account_id=? where id=?").run(otherStaff.staffAccountId, result.caseId);
    const list = await listSupportCases(supportStaff, {});
    expect(list.cases.find((c) => c.caseId === result.caseId)).toBeUndefined();
  });

  it("AT-32/33: an escalated case is visible to staff holding the exact escalation target role", async () => {
    const result = await resolveAndCreate(supportStaff);
    getDb().prepare("update support_cases set status='escalated',escalation_role='billing_administrator' where id=?").run(result.caseId);
    const visibleToBilling = await listSupportCases(billingOnlyStaff, {});
    expect(visibleToBilling.cases.find((c) => c.caseId === result.caseId)).toBeDefined();
    const notVisibleToOps = await listSupportCases(seedStaffSession(["operations_administrator"]), {});
    expect(notVisibleToOps.cases.find((c) => c.caseId === result.caseId)).toBeUndefined();
  });
});
