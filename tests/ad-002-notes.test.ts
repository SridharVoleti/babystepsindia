// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { addSupportCaseNote, createSupportCase, listSupportCaseNotes, resolveCustomer, updateSupportCaseWorkflow } from "@/lib/support-cases/service";
import { SupportCaseError } from "@/lib/support-cases/contracts";

let parentEmail: string;
let staff: ReturnType<typeof seedStaffSession>;
let caseId: string;

const REASON = "Parent asked why their last payment attempt failed.";

beforeEach(async () => {
  useInMemoryDb();
  parentEmail = `parent-${randomUUID()}@example.com`;
  const { user } = await sqliteAuthAdapter.signUp(parentEmail, "CorrectHorse1!");
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", user.id);
  staff = seedStaffSession(["support_agent"]);
  const resolved = await resolveCustomer(staff, { identifierType: "email", identifierValue: parentEmail, reason: REASON });
  caseId = (await createSupportCase(staff, { receiptId: resolved.receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() })).caseId;
});

describe("AD-002 addSupportCaseNote (AT-AD-002-25/26/27)", () => {
  it("AT-25: appends an internal note attributed to the exact staff member", async () => {
    const note = await addSupportCaseNote(staff, caseId, { noteText: "Confirmed the parent's payment method expired.", idempotencyKey: randomUUID() });
    expect(note.staffAccountId).toBe(staff.staffAccountId);
    expect(await listSupportCaseNotes(caseId)).toHaveLength(1);
  });

  it("AT-26: no update/delete function or route exists for notes — append-only by construction", async () => {
    const serviceSource = fs.readFileSync("src/lib/support-cases/service.ts", "utf8");
    expect(serviceSource).not.toMatch(/update\s+support_case_notes\s+set/i);
    expect(serviceSource).not.toMatch(/delete\s+from\s+support_case_notes/i);
    expect(fs.existsSync("src/app/v1/admin/support/cases/[caseId]/notes/[noteId]")).toBe(false);
  });

  it("AT-27: a note containing password/card-shaped content is rejected", async () => {
    await expect(addSupportCaseNote(staff, caseId, { noteText: "parent's password: hunter2live", idempotencyKey: randomUUID() }))
      .rejects.toThrow(SupportCaseError);
    await expect(addSupportCaseNote(staff, caseId, { noteText: "card number 4111111111111111 confirmed", idempotencyKey: randomUUID() }))
      .rejects.toThrow(SupportCaseError);
  });

  it("rejects a note shorter than 1 or longer than 4000 visible characters", async () => {
    await expect(addSupportCaseNote(staff, caseId, { noteText: "", idempotencyKey: randomUUID() })).rejects.toThrow(SupportCaseError);
    await expect(addSupportCaseNote(staff, caseId, { noteText: "x".repeat(4001), idempotencyKey: randomUUID() })).rejects.toThrow(SupportCaseError);
  });

  it("replaying the same idempotencyKey for the same staff+case returns the same note, not a duplicate", async () => {
    const idempotencyKey = randomUUID();
    const first = await addSupportCaseNote(staff, caseId, { noteText: "Left a callback message.", idempotencyKey });
    const second = await addSupportCaseNote(staff, caseId, { noteText: "Left a callback message.", idempotencyKey });
    expect(second.noteId).toBe(first.noteId);
    expect(await listSupportCaseNotes(caseId)).toHaveLength(1);
  });

  it("a closed case rejects new notes", async () => {
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 1, idempotencyKey: randomUUID(), status: "resolved" });
    await updateSupportCaseWorkflow(staff, caseId, { expectedVersion: 2, idempotencyKey: randomUUID(), status: "closed" });
    await expect(addSupportCaseNote(staff, caseId, { noteText: "Trying to add after close.", idempotencyKey: randomUUID() }))
      .rejects.toThrow(SupportCaseError);
  });
});
