// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { ensureBootstrapPlatformAdmin, seedStaffSession } from "./helpers/staff-session-fixture";
import { queryPrivilegedAudit } from "@/lib/platform-governance/audit-viewer";
import { PlatformGovernanceError } from "@/lib/platform-governance/contracts";

let staffId: string;

beforeEach(async () => {
  useInMemoryDb();
  staffId = ensureBootstrapPlatformAdmin();
});

// FK targets for support_case_activity.case_id / platform_operation_activity.operation_change_id
// — minimal real parent rows, not a placeholder string, since both columns
// are real foreign keys.
async function seedSupportCase(caseId: string) {
  const { user } = await sqliteAuthAdapter.signUp(`parent-${randomUUID()}@example.com`, "CorrectHorse1!");
  const now = new Date().toISOString();
  getDb().prepare(
    `insert into support_cases(id,category,parent_id,created_from_receipt_id,created_by_staff_account_id,created_at,updated_at)
     values (?,?,?,?,?,?,?)`,
  ).run(caseId, "other", user.id, randomUUID(), staffId, now, now);
}

function seedOperationChange(operationChangeId: string) {
  const now = new Date().toISOString();
  getDb().prepare(
    `insert into platform_operation_changes(id,change_type,environment,reason,created_by_staff_account_id,created_at,updated_at)
     values (?,?,?,?,?,?,?)`,
  ).run(operationChangeId, "app_registry_change", "production", "Seeded for an audit-viewer composition test.", staffId, now, now);
}

function insertStaffAudit(overrides: Partial<{
  id: string; actor: string; action: string; result: string; createdAt: string;
}> = {}) {
  const id = overrides.id ?? randomUUID();
  getDb().prepare(
    `insert into staff_audit_log(id,actor_staff_account_id,canonical_action,result,created_at)
     values (?,?,?,?,?)`,
  ).run(id, overrides.actor ?? staffId, overrides.action ?? "admin.staff.status.update",
    overrides.result ?? "success", overrides.createdAt ?? new Date().toISOString());
  return id;
}

async function insertCaseActivity(caseId: string, createdAt = new Date().toISOString()) {
  await seedSupportCase(caseId);
  const id = randomUUID();
  getDb().prepare(
    `insert into support_case_activity(id,case_id,actor_staff_account_id,canonical_action,underlying_role,result,created_at)
     values (?,?,?,?,?,?,?)`,
  ).run(id, caseId, staffId, "admin.support.case.create", "support_agent", "success", createdAt);
  return id;
}

function insertOperationActivity(operationChangeId: string, createdAt = new Date().toISOString()) {
  seedOperationChange(operationChangeId);
  const id = randomUUID();
  getDb().prepare(
    `insert into platform_operation_activity(id,operation_change_id,staff_account_id,canonical_action,underlying_role,result,created_at)
     values (?,?,?,?,?,?,?)`,
  ).run(id, operationChangeId, staffId, "admin.operations.change.create", "operations_administrator", "success", createdAt);
  return id;
}

describe("AD-005 queryPrivilegedAudit (AT-AD-005-33-40)", () => {
  it("AT-33/79: composes across all three append-only sources live, no new audit table", async () => {
    insertStaffAudit();
    await insertCaseActivity("case-1");
    insertOperationActivity("op-1");
    const result = queryPrivilegedAudit({ from: "2020-01-01T00:00:00.000Z", to: new Date(Date.now() + 60_000).toISOString() });
    const sources = result.events.map((e) => e.source).sort();
    expect(sources).toEqual(["operation_change", "staff", "support_case"]);
  });

  it("AT-34: an unrecognized wide time window with no narrowing filter is silently clamped to 90 days, never rejected", () => {
    const farPast = new Date(Date.now() - 400 * 24 * 60 * 60_000);
    insertStaffAudit({ createdAt: farPast.toISOString() });
    const recent = insertStaffAudit({ createdAt: new Date().toISOString() });
    const result = queryPrivilegedAudit({ from: farPast.toISOString(), to: new Date(Date.now() + 60_000).toISOString() });
    expect(result.events.some((e) => e.id === recent)).toBe(true);
  });

  it("AT-36: filters by canonicalAction, staffAccountId, caseId and operationChangeId (allowlisted, not free-form)", async () => {
    const otherStaffId = seedStaffSession(["support_agent"]).staffAccountId;
    insertStaffAudit({ actor: otherStaffId });
    await insertCaseActivity("case-only");
    insertOperationActivity("op-only");
    const from = "2020-01-01T00:00:00.000Z";
    const to = new Date(Date.now() + 60_000).toISOString();
    expect(queryPrivilegedAudit({ from, to, staffAccountId: otherStaffId }).events).toHaveLength(1);
    expect(queryPrivilegedAudit({ from, to, caseId: "case-only" }).events).toHaveLength(1);
    expect(queryPrivilegedAudit({ from, to, operationChangeId: "op-only" }).events).toHaveLength(1);
  });

  it("rejects an invalid or inverted time range", () => {
    expect(() => queryPrivilegedAudit({ from: "not-a-date", to: new Date().toISOString() })).toThrow(PlatformGovernanceError);
    expect(() => queryPrivilegedAudit({ from: new Date().toISOString(), to: "2020-01-01T00:00:00.000Z" })).toThrow(PlatformGovernanceError);
  });

  it("AT-37/38: never exposes a raw secret/payload field — only the allowlisted safe columns are ever selected", () => {
    insertStaffAudit();
    const result = queryPrivilegedAudit({ from: "2020-01-01T00:00:00.000Z", to: new Date(Date.now() + 60_000).toISOString() });
    for (const event of result.events) {
      expect(Object.keys(event).sort()).toEqual([
        "actorStaffAccountId", "canonicalAction", "caseId", "createdAt", "id", "operationChangeId",
        "resourceSafeId", "resourceType", "result", "source", "underlyingRole",
      ]);
    }
  });

  it("paginates newest-first with a cursor, capped at 100 per page", () => {
    for (let i = 0; i < 5; i += 1) {
      insertStaffAudit({ createdAt: new Date(Date.now() - i * 1000).toISOString() });
    }
    const first = queryPrivilegedAudit({ from: "2020-01-01T00:00:00.000Z", to: new Date(Date.now() + 60_000).toISOString(), limit: 2 });
    expect(first.events).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = queryPrivilegedAudit({
      from: "2020-01-01T00:00:00.000Z", to: new Date(Date.now() + 60_000).toISOString(), limit: 2, cursor: first.nextCursor!,
    });
    expect(second.events[0]!.id).not.toBe(first.events[0]!.id);
  });
});
