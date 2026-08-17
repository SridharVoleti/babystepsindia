// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStaffSession: vi.fn() }));
vi.mock("@/lib/staff-identity/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staff-identity/session")>()),
  getStaffSession: mocks.getStaffSession,
}));

import { GET as listRecords, POST as startRecord } from "@/app/v1/admin/platform/recovery-tests/route";
import { GET as getRecord, PATCH as updateRecord } from "@/app/v1/admin/platform/recovery-tests/[recordId]/route";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { ensureBootstrapPlatformAdmin, seedStaffSession } from "./helpers/staff-session-fixture";
import { STAFF_ROLE_KEYS } from "@/lib/staff-identity/contracts";

beforeEach(() => {
  useInMemoryDb();
  ensureBootstrapPlatformAdmin();
  mocks.getStaffSession.mockReset();
});

function postReq(body: unknown) {
  return new Request("http://localhost/v1/admin/platform/recovery-tests", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
function patchReq(body: unknown) {
  return new Request("http://localhost", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /v1/admin/platform/recovery-tests — Super Admin only", () => {
  it("a platform_administrator alone (not all 4 roles) is denied with SUPER_ADMIN_REQUIRED", async () => {
    mocks.getStaffSession.mockResolvedValue(seedStaffSession(["platform_administrator"]));
    const response = await startRecord(postReq({ backupReference: "b-1", tempProjectReference: "t-1", idempotencyKey: "k-1" }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "SUPER_ADMIN_REQUIRED" });
  });

  it("a role without the base capability at all is denied before the Super Admin check even runs", async () => {
    mocks.getStaffSession.mockResolvedValue(seedStaffSession(["support_agent"]));
    const response = await startRecord(postReq({ backupReference: "b-1", tempProjectReference: "t-1", idempotencyKey: "k-2" }));
    expect(response.status).toBe(403);
  });

  it("Super Admin (all 4 roles) can start a record", async () => {
    mocks.getStaffSession.mockResolvedValue(seedStaffSession([...STAFF_ROLE_KEYS]));
    const response = await startRecord(postReq({ backupReference: "b-1", tempProjectReference: "t-1", outboundProcessingSuppressed: true, idempotencyKey: "k-3" }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.backupReference).toBe("b-1");
  });
});

describe("GET /v1/admin/platform/recovery-tests — any Platform Administrator can read", () => {
  it("a platform_administrator alone can list the evidence log", async () => {
    mocks.getStaffSession.mockResolvedValue(seedStaffSession(["platform_administrator"]));
    const response = await listRecords();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.records).toEqual([]);
  });
});

describe("PATCH /v1/admin/platform/recovery-tests/{id} — Super Admin only", () => {
  it("a platform_administrator alone cannot update an evidence record", async () => {
    mocks.getStaffSession.mockResolvedValue(seedStaffSession([...STAFF_ROLE_KEYS]));
    const created = await (await startRecord(postReq({ backupReference: "b-1", tempProjectReference: "t-1", idempotencyKey: "k-4" }))).json();

    mocks.getStaffSession.mockResolvedValue(seedStaffSession(["platform_administrator"]));
    const response = await updateRecord(patchReq({ deletionReplay: { confirmed: true }, idempotencyKey: "k-4-step" }), { params: { recordId: created.id } });
    expect(response.status).toBe(403);
  });

  it("Super Admin can record a step outcome", async () => {
    mocks.getStaffSession.mockResolvedValue(seedStaffSession([...STAFF_ROLE_KEYS]));
    const created = await (await startRecord(postReq({ backupReference: "b-1", tempProjectReference: "t-1", idempotencyKey: "k-5" }))).json();

    const response = await updateRecord(
      patchReq({ deletionReplay: { confirmed: true, notes: "clean" }, idempotencyKey: "k-5-step" }), { params: { recordId: created.id } },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.deletionReplayConfirmed).toBe(true);
  });

  it("GET a single record works for any Platform Administrator", async () => {
    mocks.getStaffSession.mockResolvedValue(seedStaffSession([...STAFF_ROLE_KEYS]));
    const created = await (await startRecord(postReq({ backupReference: "b-1", tempProjectReference: "t-1", idempotencyKey: "k-6" }))).json();

    mocks.getStaffSession.mockResolvedValue(seedStaffSession(["platform_administrator"]));
    const response = await getRecord(new Request("http://localhost"), { params: { recordId: created.id } });
    expect(response.status).toBe(200);
  });
});
