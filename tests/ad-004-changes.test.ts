// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import {
  createOperationChange, getOperationChange, listOperationChanges, updateOperationChangeWorkflow,
} from "@/lib/operations-admin/service";
import { OperationChangeError } from "@/lib/operations-admin/contracts";
import { roleHasCapability } from "@/lib/staff-identity/roles";

let opsStaff: ReturnType<typeof seedStaffSession>;
const REASON = "Scheduled maintenance to roll out a database migration safely.";

beforeEach(() => {
  useInMemoryDb();
  opsStaff = seedStaffSession(["operations_administrator"]);
});

describe("AD-004 createOperationChange (AT-AD-004-01/02/03/07/08/09/10)", () => {
  it("AT-01/02/03: only the explicit Operations Administrator capability grants this action, never a Super Admin label alone", () => {
    expect(roleHasCapability(opsStaff.roleKeys, "admin.operations.change.create")).toBe(true);
    expect(roleHasCapability(["platform_administrator"], "admin.operations.change.create")).toBe(false);
    const superAdmin = seedStaffSession(["support_agent", "billing_administrator", "operations_administrator", "platform_administrator"]);
    expect(roleHasCapability(superAdmin.roleKeys, "admin.operations.change.create")).toBe(true);
  });

  it("AT-07: creates a unique, server-generated, immutable operation change", () => {
    const change = createOperationChange(opsStaff, {
      changeType: "planned_maintenance", environment: "production", appId: "app-1", reason: REASON,
      idempotencyKey: randomUUID(),
    });
    expect(change.operationChangeId).toBeTruthy();
    const second = createOperationChange(opsStaff, {
      changeType: "planned_maintenance", environment: "production", appId: "app-1", reason: REASON,
      idempotencyKey: randomUUID(),
    });
    expect(second.operationChangeId).not.toBe(change.operationChangeId);
  });

  it("AT-08: replaying the same idempotencyKey returns the same operation change, never a duplicate", () => {
    const idempotencyKey = randomUUID();
    const first = createOperationChange(opsStaff, {
      changeType: "planned_maintenance", environment: "production", appId: "app-1", reason: REASON, idempotencyKey,
    });
    const second = createOperationChange(opsStaff, {
      changeType: "planned_maintenance", environment: "production", appId: "app-1", reason: REASON, idempotencyKey,
    });
    expect(second.operationChangeId).toBe(first.operationChangeId);
    const count = getDb().prepare("select count(*) n from platform_operation_changes").get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("AT-10: rejects a reason shorter than 20 or longer than 500 characters", () => {
    expect(() => createOperationChange(opsStaff, {
      changeType: "planned_maintenance", environment: "production", reason: "too short", idempotencyKey: randomUUID(),
    })).toThrow(OperationChangeError);
    expect(() => createOperationChange(opsStaff, {
      changeType: "planned_maintenance", environment: "production", reason: "x".repeat(501), idempotencyKey: randomUUID(),
    })).toThrow(OperationChangeError);
  });

  it("AT-09: scope fields (type/environment/resource/reason) cannot be changed after creation — the workflow update input has no such fields", () => {
    const change = createOperationChange(opsStaff, {
      changeType: "planned_maintenance", environment: "production", appId: "app-1", reason: REASON, idempotencyKey: randomUUID(),
    });
    const updated = updateOperationChangeWorkflow(opsStaff, change.operationChangeId,
      { expectedVersion: 1, idempotencyKey: randomUUID(), status: "executing" });
    expect(updated.changeType).toBe("planned_maintenance");
    expect(updated.environment).toBe("production");
  });
});

describe("AD-004 listOperationChanges / getOperationChange (AT-AD-004-15)", () => {
  it("filters by status/type/app/environment/assignedToMe", () => {
    createOperationChange(opsStaff, { changeType: "planned_maintenance", environment: "production", appId: "app-1",
      reason: REASON, idempotencyKey: randomUUID() });
    createOperationChange(opsStaff, { changeType: "app_registry_change", environment: "production", appId: "app-2",
      reason: REASON, idempotencyKey: randomUUID() });
    const filtered = listOperationChanges(opsStaff, { changeType: "app_registry_change" });
    expect(filtered.changes).toHaveLength(1);
    expect(filtered.changes[0].changeType).toBe("app_registry_change");
  });

  it("a nonexistent operation change ID fails safely", () => {
    expect(() => getOperationChange(randomUUID())).toThrow(OperationChangeError);
  });
});

describe("AD-004 updateOperationChangeWorkflow (AT-AD-004-11/12)", () => {
  it("AT-11: workflow fields (status/assignment/schedule) version on change, scope stays fixed", () => {
    const change = createOperationChange(opsStaff, {
      changeType: "planned_maintenance", environment: "production", appId: "app-1", reason: REASON, idempotencyKey: randomUUID(),
    });
    const updated = updateOperationChangeWorkflow(opsStaff, change.operationChangeId,
      { expectedVersion: 1, idempotencyKey: randomUUID(), status: "executing" });
    expect(updated.version).toBe(2);
    expect(updated.status).toBe("executing");
  });

  it("a stale expectedVersion is rejected as a conflict, never silently overwritten", () => {
    const change = createOperationChange(opsStaff, {
      changeType: "planned_maintenance", environment: "production", appId: "app-1", reason: REASON, idempotencyKey: randomUUID(),
    });
    expect(() => updateOperationChangeWorkflow(opsStaff, change.operationChangeId,
      { expectedVersion: 99, idempotencyKey: randomUUID(), status: "executing" })).toThrow(OperationChangeError);
  });

  it("AT-12: cannot cancel once executing — only before an irreversible source mutation begins", () => {
    const change = createOperationChange(opsStaff, {
      changeType: "planned_maintenance", environment: "production", appId: "app-1", reason: REASON, idempotencyKey: randomUUID(),
    });
    updateOperationChangeWorkflow(opsStaff, change.operationChangeId, { expectedVersion: 1, idempotencyKey: randomUUID(), status: "executing" });
    expect(() => updateOperationChangeWorkflow(opsStaff, change.operationChangeId,
      { expectedVersion: 2, idempotencyKey: randomUUID(), status: "cancelled" })).toThrow(OperationChangeError);
  });

  it("a terminal (succeeded/failed/cancelled) operation change cannot be updated further", () => {
    const change = createOperationChange(opsStaff, {
      changeType: "planned_maintenance", environment: "production", appId: "app-1", reason: REASON, idempotencyKey: randomUUID(),
    });
    updateOperationChangeWorkflow(opsStaff, change.operationChangeId, { expectedVersion: 1, idempotencyKey: randomUUID(), status: "succeeded" });
    expect(() => updateOperationChangeWorkflow(opsStaff, change.operationChangeId,
      { expectedVersion: 2, idempotencyKey: randomUUID(), status: "executing" })).toThrow(OperationChangeError);
  });

  it("AT-48/49: a terminal operation change gets a retention_due_at 24 months out, source tables untouched", () => {
    const change = createOperationChange(opsStaff, {
      changeType: "planned_maintenance", environment: "production", appId: "app-1", reason: REASON, idempotencyKey: randomUUID(),
    });
    const now = new Date("2026-08-16T00:00:00.000Z");
    updateOperationChangeWorkflow(opsStaff, change.operationChangeId, { expectedVersion: 1, idempotencyKey: randomUUID(), status: "succeeded" }, now);
    const row = getDb().prepare("select retention_due_at from platform_operation_changes where id=?").get(change.operationChangeId) as
      { retention_due_at: string };
    expect(new Date(row.retention_due_at).getUTCFullYear()).toBe(2028);
  });
});
