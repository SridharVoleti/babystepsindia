// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStaffSession: vi.fn(), hasLiveReauthReceipt: vi.fn() }));
vi.mock("@/lib/staff-identity/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staff-identity/session")>()),
  getStaffSession: mocks.getStaffSession,
}));
vi.mock("@/lib/staff-identity/reauth-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staff-identity/reauth-service")>()),
  hasLiveReauthReceipt: mocks.hasLiveReauthReceipt,
}));

import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { resetRateLimitsForTests } from "@/lib/auth/rate-limit";
import { seedStaffSession } from "./helpers/staff-session-fixture";
import { createOperationChange } from "@/lib/operations-admin/service";
import { POST as postSoftDelete } from "@/app/v1/admin/apps/[appId]/soft-delete/route";
import { POST as postMaintenanceWindow } from "@/app/v1/admin/apps/[appId]/maintenance-windows/route";

const appId = "app-ad004-test";

function jsonRequest(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function asStaff(roleKeys: Parameters<typeof seedStaffSession>[0]) {
  const session = seedStaffSession(roleKeys);
  mocks.getStaffSession.mockResolvedValue(session);
  const now = new Date();
  getDb().prepare(
    `insert into staff_reauth_receipts(id, staff_session_id, staff_account_id, reauth_at, valid_until, factors_json)
     values (?,?,?,?,?,'{}')`,
  ).run(randomUUID(), session.sessionId, session.staffAccountId, now.toISOString(),
    new Date(now.getTime() + 10 * 60 * 1000).toISOString());
  return session;
}

beforeEach(() => {
  useInMemoryDb();
  resetRateLimitsForTests();
  mocks.hasLiveReauthReceipt.mockReturnValue(true);
  getDb().prepare(
    `insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status,version)
     values(?,?,?,'Test app','icon','learning','team','active',1)`,
  ).run(appId, appId, "AD-004 Test App");
});

describe("AD-004 amended AR-001 soft-delete route (AT-AD-004-13/15/17)", () => {
  it("AT-13: rejects the mutation outright when no operationChangeId is supplied", async () => {
    const staff = asStaff(["operations_administrator"]);
    const response = await postSoftDelete(jsonRequest(`http://x/v1/admin/apps/${appId}/soft-delete`, {
      expectedVersion: 1, idempotencyKey: randomUUID(), reasonCode: "discontinued", confirmationAppKey: appId,
    }), { params: { appId } });
    expect(response.status).toBe(400);
    void staff;
  });

  it("AT-15: rejects an operation change scoped to a DIFFERENT app", async () => {
    const staff = asStaff(["operations_administrator"]);
    const change = createOperationChange(staff, {
      changeType: "app_registry_change", environment: "production", appId: "some-other-app",
      reason: "Investigating a different app entirely, not this one.", idempotencyKey: randomUUID(),
    });
    const response = await postSoftDelete(jsonRequest(`http://x/v1/admin/apps/${appId}/soft-delete`, {
      expectedVersion: 1, idempotencyKey: randomUUID(), reasonCode: "discontinued", confirmationAppKey: appId,
      operationChangeId: change.operationChangeId,
    }), { params: { appId } });
    expect(response.status).toBe(409);
  });

  it("AT-17: succeeds and delegates to AR-001 when the operation change is valid and correctly scoped", async () => {
    const staff = asStaff(["operations_administrator"]);
    const change = createOperationChange(staff, {
      changeType: "app_registry_change", environment: "production", appId,
      reason: "Discontinuing this app after zero active learners for 90 days.", idempotencyKey: randomUUID(),
    });
    const response = await postSoftDelete(jsonRequest(`http://x/v1/admin/apps/${appId}/soft-delete`, {
      expectedVersion: 1, idempotencyKey: randomUUID(), reasonCode: "discontinued", confirmationAppKey: appId,
      operationChangeId: change.operationChangeId,
    }), { params: { appId } });
    expect(response.status).toBe(200);
    const row = getDb().prepare("select registry_status from app_registry where id=?").get(appId) as { registry_status: string };
    expect(row.registry_status).toBe("soft_deleted");
    const activity = getDb().prepare(
      "select result from platform_operation_activity where operation_change_id=? and canonical_action='admin.app.delete'",
    ).get(change.operationChangeId) as { result: string } | undefined;
    expect(activity?.result).toBe("success");
  });
});

describe("AD-004 amended UL-004 maintenance-window route (AT-AD-004-13/27)", () => {
  it("AT-13: rejects without an operationChangeId", async () => {
    asStaff(["operations_administrator"]);
    const response = await postMaintenanceWindow(jsonRequest(`http://x/v1/admin/apps/${appId}/maintenance-windows`, {
      environment: "production", startsAt: "2026-09-01T10:00:00Z", endsAt: "2026-09-01T11:00:00Z",
      reasonCategory: "planned", expectedAvailabilityVersion: 1, idempotencyKey: randomUUID(),
    }), { params: { appId } });
    expect(response.status).toBe(400);
  });

  it("AT-27: succeeds and delegates to UL-004 when the operation change is valid", async () => {
    const staff = asStaff(["operations_administrator"]);
    const change = createOperationChange(staff, {
      changeType: "planned_maintenance", environment: "production", appId,
      reason: "Scheduling a maintenance window for a database migration.", idempotencyKey: randomUUID(),
    });
    const response = await postMaintenanceWindow(jsonRequest(`http://x/v1/admin/apps/${appId}/maintenance-windows`, {
      environment: "production", startsAt: "2026-09-01T10:00:00Z", endsAt: "2026-09-01T11:00:00Z",
      reasonCategory: "planned", expectedAvailabilityVersion: 1, idempotencyKey: randomUUID(),
      operationChangeId: change.operationChangeId,
    }), { params: { appId } });
    expect(response.status).toBe(201);
  });
});
