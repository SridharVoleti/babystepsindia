// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStaffSession: vi.fn() }));
vi.mock("@/lib/staff-identity/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staff-identity/session")>()),
  getStaffSession: mocks.getStaffSession,
}));

import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { resetRateLimitsForTests } from "@/lib/auth/rate-limit";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { POST as postResolve } from "@/app/v1/admin/support/resolve-customer/route";
import { POST as postCreateCase, GET as getCases } from "@/app/v1/admin/support/cases/route";
import { GET as getCase, PATCH as patchCase } from "@/app/v1/admin/support/cases/[caseId]/route";
import { POST as postNote } from "@/app/v1/admin/support/cases/[caseId]/notes/route";
import { POST as postReopen } from "@/app/v1/admin/support/cases/[caseId]/reopen/route";

let parentEmail: string;
const REASON = "Parent emailed asking about a refund that hasn't appeared yet.";

beforeEach(async () => {
  useInMemoryDb();
  resetRateLimitsForTests();
  parentEmail = `parent-${randomUUID()}@example.com`;
  const { user } = await sqliteAuthAdapter.signUp(parentEmail, "CorrectHorse1!");
  getDb().prepare("update users set email_verified_at=? where id=?").run("2026-08-01T00:00:00.000Z", user.id);
});

function asStaff(roleKeys: Parameters<typeof seedStaffSession>[0]) {
  const session = seedStaffSession(roleKeys);
  mocks.getStaffSession.mockResolvedValue(session);
  return session;
}

function jsonRequest(url: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}

describe("AD-002 routes (AT-AD-002-08/11/40/42)", () => {
  it("rejects an unauthenticated resolve-customer call", async () => {
    mocks.getStaffSession.mockResolvedValue(null);
    const response = await postResolve(jsonRequest("http://x/v1/admin/support/resolve-customer", "POST",
      { identifierType: "email", identifierValue: parentEmail, reason: REASON }));
    expect(response.status).toBe(401);
  });

  it("AT-11: rejects a billing-only staff member (no Support capability)", async () => {
    asStaff(["billing_administrator"]);
    const response = await postResolve(jsonRequest("http://x/v1/admin/support/resolve-customer", "POST",
      { identifierType: "email", identifierValue: parentEmail, reason: REASON }));
    expect(response.status).toBe(403);
  });

  it("AT-08: rate-limits a burst of resolver calls", async () => {
    asStaff(["support_agent"]);
    let sawLimited = false;
    for (let i = 0; i < 25; i++) {
      const response = await postResolve(jsonRequest("http://x/v1/admin/support/resolve-customer", "POST",
        { identifierType: "email", identifierValue: parentEmail, reason: REASON }));
      if (response.status === 429) sawLimited = true;
    }
    expect(sawLimited).toBe(true);
  });

  it("full happy path: resolve -> create -> list -> read -> note -> workflow -> resolve -> reopen", async () => {
    asStaff(["support_agent"]);
    const resolveResponse = await postResolve(jsonRequest("http://x/v1/admin/support/resolve-customer", "POST",
      { identifierType: "email", identifierValue: parentEmail, reason: REASON }));
    expect(resolveResponse.status).toBe(200);
    const { receiptId } = await resolveResponse.json();

    const createResponse = await postCreateCase(jsonRequest("http://x/v1/admin/support/cases", "POST",
      { receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() }));
    expect(createResponse.status).toBe(201);
    const { caseId } = await createResponse.json();

    const listResponse = await getCases(new Request("http://x/v1/admin/support/cases"));
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody.cases.some((c: { caseId: string }) => c.caseId === caseId)).toBe(true);

    const readResponse = await getCase(new Request(`http://x/v1/admin/support/cases/${caseId}`), { params: { caseId } });
    expect(readResponse.status).toBe(200);
    const readBody = await readResponse.json();
    expect(readBody.parent).toBeDefined();

    const noteResponse = await postNote(jsonRequest(`http://x/v1/admin/support/cases/${caseId}/notes`, "POST",
      { noteText: "Confirmed refund is still processing.", idempotencyKey: randomUUID() }), { params: { caseId } });
    expect(noteResponse.status).toBe(201);

    const resolveWorkflowResponse = await patchCase(jsonRequest(`http://x/v1/admin/support/cases/${caseId}`, "PATCH",
      { expectedVersion: readBody.version, idempotencyKey: randomUUID(), status: "resolved" }), { params: { caseId } });
    expect(resolveWorkflowResponse.status).toBe(200);

    const reopenResponse = await postReopen(jsonRequest(`http://x/v1/admin/support/cases/${caseId}/reopen`, "POST",
      { reason: "Parent has a follow-up question about the refund.", idempotencyKey: randomUUID() }), { params: { caseId } });
    expect(reopenResponse.status).toBe(200);
    const reopenBody = await reopenResponse.json();
    expect(reopenBody.status).toBe("open");
  });

  it("AT-40: a foreign/nonexistent case returns a safe non-enumerating 404", async () => {
    asStaff(["support_agent"]);
    const response = await getCase(new Request("http://x/v1/admin/support/cases/does-not-exist"),
      { params: { caseId: "does-not-exist" } });
    expect(response.status).toBe(404);
  });

  it("AT-42: the GET case response never puts sensitive data in headers/URL — only an opaque version ETag", async () => {
    asStaff(["support_agent"]);
    const resolveResponse = await postResolve(jsonRequest("http://x/v1/admin/support/resolve-customer", "POST",
      { identifierType: "email", identifierValue: parentEmail, reason: REASON }));
    const { receiptId } = await resolveResponse.json();
    const createResponse = await postCreateCase(jsonRequest("http://x/v1/admin/support/cases", "POST",
      { receiptId, category: "billing_question", reason: REASON, idempotencyKey: randomUUID() }));
    const { caseId } = await createResponse.json();
    const readResponse = await getCase(new Request(`http://x/v1/admin/support/cases/${caseId}`), { params: { caseId } });
    expect(readResponse.headers.get("ETag")).toMatch(/^"\d+"$/);
  });
});
