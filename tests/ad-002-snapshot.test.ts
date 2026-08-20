// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { createSupportCase, resolveCustomer } from "@/lib/support-cases/service";
import { composeCaseSnapshotSections } from "@/lib/support-cases/snapshot";

let parentId: string;
let parentEmail: string;
let staff: ReturnType<typeof seedStaffSession>;

const REASON = "Parent wants to know if their child's account access is working correctly.";

beforeEach(async () => {
  useInMemoryDb();
  parentEmail = `parent-${randomUUID()}@example.com`;
  const { user } = await sqliteAuthAdapter.signUp(parentEmail, "CorrectHorse1!");
  parentId = user.id;
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", parentId);
  getDb().prepare("update profiles set display_name=? where id=?").run("Snap Parent", parentId);
  staff = seedStaffSession(["support_agent"]);
});

async function makeCase(category: string) {
  const resolved = await resolveCustomer(staff, { identifierType: "email", identifierValue: parentEmail, reason: REASON });
  return (await createSupportCase(staff, { receiptId: resolved.receiptId, category: category as never, reason: REASON, idempotencyKey: randomUUID() })).caseId;
}

describe("AD-002 composeCaseSnapshotSections (AT-AD-002-14/15/16/17/19/20)", () => {
  it("AT-14: an account_access case shows only safe parent fields, no auth secrets", async () => {
    const caseId = await makeCase("account_access");
    const sections = (await composeCaseSnapshotSections(caseId))!;
    expect(sections.parent.displayName).toBe("Snap Parent");
    expect(sections.parent.maskedEmail).not.toBe(parentEmail);
    expect(sections.learner).toBeUndefined();
    expect(sections.billing).toBeUndefined();
    expect(JSON.stringify(sections)).not.toMatch(/password_hash|passkey|challenge/i);
  });

  it("AT-19: unrelated sections are omitted entirely — a billing_question case never composes a learner section", async () => {
    const caseId = await makeCase("billing_question");
    const sections = (await composeCaseSnapshotSections(caseId))!;
    expect(sections.learner).toBeUndefined();
    expect(sections.progress).toBeUndefined();
    expect(sections.technicalIssue).toBeUndefined();
  });

  it("AT-15: a learner_access case shows learner name/access/apps, never full DOB", async () => {
    const learnerId = (await createLearner(parentId, { displayName: "Kiddo", dateOfBirth: "2018-01-01",
      idempotencyKey: randomUUID() }, "2026-08-16")).learner.id;
    const resolved = await resolveCustomer(staff, { identifierType: "email", identifierValue: parentEmail, reason: REASON });
    const caseId = (await createSupportCase(staff, { receiptId: resolved.receiptId, category: "learner_access", reason: REASON, idempotencyKey: randomUUID() })).caseId;
    getDb().prepare("update support_cases set learner_id=? where id=?").run(learnerId, caseId);
    const sections = (await composeCaseSnapshotSections(caseId))!;
    expect(sections.learner?.displayName).toBe("Kiddo");
    expect(JSON.stringify(sections)).not.toMatch(/2018-01-01/);
  });

  it("AT-20: viewing a snapshot mutates nothing — pure read", async () => {
    const caseId = await makeCase("account_access");
    const before = getDb().prepare("select updated_at from support_cases where id=?").get(caseId) as { updated_at: string };
    await composeCaseSnapshotSections(caseId);
    await composeCaseSnapshotSections(caseId);
    const after = getDb().prepare("select updated_at from support_cases where id=?").get(caseId) as { updated_at: string };
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("AT-17: a billing_question case with no bound subscription omits the billing section rather than fabricating one", async () => {
    const caseId = await makeCase("billing_question");
    const sections = (await composeCaseSnapshotSections(caseId))!;
    expect(sections.billing).toBeUndefined();
  });
});
