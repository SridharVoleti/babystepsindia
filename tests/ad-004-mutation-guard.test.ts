// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import {
  createOperationChange, requireOperationChangeForMutation, recordOperationOutcome, getOperationChange,
} from "@/lib/operations-admin/service";
import { OperationChangeError } from "@/lib/operations-admin/contracts";

let opsStaff: ReturnType<typeof seedStaffSession>;
const REASON = "Soft-deleting a discontinued app after confirming zero active learners.";

beforeEach(() => {
  useInMemoryDb();
  opsStaff = seedStaffSession(["operations_administrator"]);
});

describe("AD-004 requireOperationChangeForMutation (AT-AD-004-13/15)", () => {
  it("AT-13: a nonexistent operationChangeId is rejected — every covered source mutation is change-bound", () => {
    expect(() => requireOperationChangeForMutation({
      operationChangeId: randomUUID(), allowedTypes: ["app_registry_change"], environment: "production", appId: "app-1",
    })).toThrow(OperationChangeError);
  });

  it("AT-15: an operation record scoped to a DIFFERENT app is rejected for this mutation", () => {
    const change = createOperationChange(opsStaff, {
      changeType: "app_registry_change", environment: "production", appId: "app-1", reason: REASON, idempotencyKey: randomUUID(),
    });
    expect(() => requireOperationChangeForMutation({
      operationChangeId: change.operationChangeId, allowedTypes: ["app_registry_change"], environment: "production", appId: "app-2",
    })).toThrow(OperationChangeError);
  });

  it("an operation record scoped to a different environment is rejected", () => {
    const change = createOperationChange(opsStaff, {
      changeType: "planned_maintenance", environment: "staging", appId: "app-1", reason: REASON, idempotencyKey: randomUUID(),
    });
    expect(() => requireOperationChangeForMutation({
      operationChangeId: change.operationChangeId, allowedTypes: ["planned_maintenance"], environment: "production", appId: "app-1",
    })).toThrow(OperationChangeError);
  });

  it("an operation record of the wrong change_type is rejected — a maintenance record cannot authorize a rollback", () => {
    const change = createOperationChange(opsStaff, {
      changeType: "planned_maintenance", environment: "production", appId: "app-1", reason: REASON, idempotencyKey: randomUUID(),
    });
    expect(() => requireOperationChangeForMutation({
      operationChangeId: change.operationChangeId, allowedTypes: ["manual_rollback"], environment: "production", appId: "app-1",
    })).toThrow(OperationChangeError);
  });

  it("a terminal (already succeeded) operation record cannot authorize a fresh mutation", () => {
    const change = createOperationChange(opsStaff, {
      changeType: "app_registry_change", environment: "production", appId: "app-1", reason: REASON, idempotencyKey: randomUUID(),
    });
    getDb().prepare("update platform_operation_changes set status='succeeded' where id=?").run(change.operationChangeId);
    expect(() => requireOperationChangeForMutation({
      operationChangeId: change.operationChangeId, allowedTypes: ["app_registry_change"], environment: "production", appId: "app-1",
    })).toThrow(OperationChangeError);
  });

  it("a valid matching operation record passes through cleanly", () => {
    const change = createOperationChange(opsStaff, {
      changeType: "app_registry_change", environment: "production", appId: "app-1", reason: REASON, idempotencyKey: randomUUID(),
    });
    const row = requireOperationChangeForMutation({
      operationChangeId: change.operationChangeId, allowedTypes: ["app_registry_change"], environment: "production", appId: "app-1",
    });
    expect(row.id).toBe(change.operationChangeId);
  });
});

describe("AD-004 recordOperationOutcome (AT-AD-004-25/35/39)", () => {
  it("AT-25: an async/accepted mutation records 'executing', never immediately 'succeeded'", () => {
    const change = createOperationChange(opsStaff, {
      changeType: "release_promotion", environment: "production", appId: "app-1", reason: REASON, idempotencyKey: randomUUID(),
    });
    recordOperationOutcome(change.operationChangeId, opsStaff.staffAccountId, "admin.deployment.promote", "executing", "deployment-1");
    expect(getOperationChange(change.operationChangeId).status).toBe("executing");
  });

  it("AT-39: every recorded outcome appends a correlated activity row with this exact operation_change_id", () => {
    const change = createOperationChange(opsStaff, {
      changeType: "app_registry_change", environment: "production", appId: "app-1", reason: REASON, idempotencyKey: randomUUID(),
    });
    recordOperationOutcome(change.operationChangeId, opsStaff.staffAccountId, "admin.app.delete", "succeeded", "app-1");
    const activity = getDb().prepare(
      "select operation_change_id, underlying_role, result from platform_operation_activity where canonical_action='admin.app.delete'",
    ).get() as { operation_change_id: string; underlying_role: string; result: string };
    expect(activity.operation_change_id).toBe(change.operationChangeId);
    expect(activity.underlying_role).toBe("operations_administrator");
    expect(activity.result).toBe("success");
  });
});
