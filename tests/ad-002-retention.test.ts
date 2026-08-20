// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { addSupportCaseNote, createSupportCase, resolveCustomer, updateSupportCaseWorkflow } from "@/lib/support-cases/service";
import { purgeExpiredSupportCaseContent } from "@/lib/support-cases/retention";

let parentEmail: string;
let staff: ReturnType<typeof seedStaffSession>;

const REASON = "Investigating an old billing dispute that was resolved long ago.";

beforeEach(async () => {
  useInMemoryDb();
  parentEmail = `parent-${randomUUID()}@example.com`;
  const { user } = await sqliteAuthAdapter.signUp(parentEmail, "CorrectHorse1!");
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", user.id);
  staff = seedStaffSession(["support_agent"]);
});

describe("AD-002 purgeExpiredSupportCaseContent (AT-AD-002-45/46)", () => {
  it("AT-45: purges notes/activity for a case closed more than 24 months ago", async () => {
    const past = new Date("2023-01-01T00:00:00.000Z");
    const resolved = await resolveCustomer(staff, { identifierType: "email", identifierValue: parentEmail, reason: REASON }, past);
    const caseId = (await createSupportCase(staff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() }, past)).caseId;
    await addSupportCaseNote(staff, caseId, { noteText: "Old note about the dispute.", idempotencyKey: randomUUID() });
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 1, idempotencyKey: randomUUID(), status: "resolved" }, past);
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 2, idempotencyKey: randomUUID(), status: "closed" }, past);

    const result = await purgeExpiredSupportCaseContent(new Date("2026-08-16T00:00:00.000Z"));
    expect(result.notesPurged).toBeGreaterThan(0);
    expect(result.activityPurged).toBeGreaterThan(0);
    expect(getDb().prepare("select count(*) n from support_case_notes where case_id=?").get(caseId)).toEqual({ n: 0 });
  });

  it("AT-46: cleanup never deletes source-domain records (users/profiles untouched)", async () => {
    const past = new Date("2023-01-01T00:00:00.000Z");
    const resolved = await resolveCustomer(staff, { identifierType: "email", identifierValue: parentEmail, reason: REASON }, past);
    const caseId = (await createSupportCase(staff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() }, past)).caseId;
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 1, idempotencyKey: randomUUID(), status: "resolved" }, past);
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 2, idempotencyKey: randomUUID(), status: "closed" }, past);

    const beforeUsers = (getDb().prepare("select count(*) n from users").get() as { n: number }).n;
    await purgeExpiredSupportCaseContent(new Date("2026-08-16T00:00:00.000Z"));
    expect((getDb().prepare("select count(*) n from users").get() as { n: number }).n).toBe(beforeUsers);
  });

  it("does not purge a recently closed case (still within retention)", async () => {
    const now = new Date("2026-08-16T00:00:00.000Z");
    const resolved = await resolveCustomer(staff, { identifierType: "email", identifierValue: parentEmail, reason: REASON }, now);
    const caseId = (await createSupportCase(staff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() }, now)).caseId;
    await addSupportCaseNote(staff, caseId, { noteText: "Recent note.", idempotencyKey: randomUUID() });
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 1, idempotencyKey: randomUUID(), status: "resolved" }, now);
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 2, idempotencyKey: randomUUID(), status: "closed" }, now);

    await purgeExpiredSupportCaseContent(now);
    expect(getDb().prepare("select count(*) n from support_case_notes where case_id=?").get(caseId)).toEqual({ n: 1 });
  });
});
