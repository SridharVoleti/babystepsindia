// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminApi: vi.fn(),
  requireStaffSensitiveReauth: vi.fn(),
  getGovernanceOverview: vi.fn(),
  issueNormalRecoverySession: vi.fn(),
  issueBreakGlassRecoverySession: vi.fn(),
  consumeRecoverySessionWithPassword: vi.fn(),
  rotateRecoveryCodes: vi.fn(),
  queryPrivilegedAudit: vi.fn(),
  restoreAccountViaGovernance: vi.fn(),
}));

vi.mock("@/lib/staff-identity/guard", () => ({
  requireAdminApi: mocks.requireAdminApi,
  requireStaffSensitiveReauth: mocks.requireStaffSensitiveReauth,
}));
vi.mock("@/lib/platform-governance/dashboard", () => ({ getGovernanceOverview: mocks.getGovernanceOverview }));
vi.mock("@/lib/platform-governance/recovery-sessions", () => ({
  issueNormalRecoverySession: mocks.issueNormalRecoverySession,
  issueBreakGlassRecoverySession: mocks.issueBreakGlassRecoverySession,
  consumeRecoverySessionWithPassword: mocks.consumeRecoverySessionWithPassword,
}));
vi.mock("@/lib/platform-governance/recovery-codes", () => ({ rotateRecoveryCodes: mocks.rotateRecoveryCodes }));
vi.mock("@/lib/platform-governance/audit-viewer", () => ({ queryPrivilegedAudit: mocks.queryPrivilegedAudit }));
vi.mock("@/lib/platform-governance/restoration", () => ({ restoreAccountViaGovernance: mocks.restoreAccountViaGovernance }));

import { GET as governanceGet } from "@/app/v1/admin/platform/governance/route";
import { POST as recoverySessionPost } from "@/app/v1/admin/platform/staff/[staffId]/recovery-sessions/route";
import { POST as breakGlassPost } from "@/app/v1/admin/platform/recovery/break-glass/route";
import { POST as consumePost } from "@/app/v1/admin/platform/recovery/consume/route";
import { POST as rotatePost } from "@/app/v1/admin/platform/recovery-codes/rotate/route";
import { GET as auditGet } from "@/app/v1/admin/platform/audit/route";
import { POST as restorePost } from "@/app/v1/admin/platform/parent-restorations/route";

function req(body: unknown, url = "https://example.test") {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const okSession = { staffAccountId: "staff-1", sessionId: "session-1", roleKeys: ["platform_administrator"] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdminApi.mockResolvedValue({ ok: true, session: okSession });
  mocks.requireStaffSensitiveReauth.mockReturnValue(null);
});

describe("AD-005 API-AD-026 governance overview", () => {
  it("requires admin.platform.governance.read and returns the overview", async () => {
    mocks.getGovernanceOverview.mockReturnValue({ staffCounts: {} });
    const res = await governanceGet();
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.platform.governance.read");
    expect(res.status).toBe(200);
  });
});

describe("AD-005 API-AD-027 normal recovery session", () => {
  it("requires the issuing capability + sensitive reauth, then issues a session", async () => {
    mocks.issueNormalRecoverySession.mockReturnValue({ recoverySessionId: "rs-1", expiresAt: "x" });
    const res = await recoverySessionPost(req({ reason: "Target lost every passkey after a phone reset." }), { params: { staffId: "target-1" } });
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.staff.recovery_session.create");
    expect(mocks.requireStaffSensitiveReauth).toHaveBeenCalled();
    expect(mocks.issueNormalRecoverySession).toHaveBeenCalledWith(
      { staffAccountId: "staff-1", roleKeys: ["platform_administrator"] },
      { targetStaffId: "target-1", reason: "Target lost every passkey after a phone reset." },
    );
    expect(res.status).toBe(201);
  });

  it("fails closed when reauth is missing", async () => {
    mocks.requireStaffSensitiveReauth.mockReturnValue(new Response(JSON.stringify({ error: "REAUTHENTICATION_REQUIRED" }), { status: 401 }));
    const res = await recoverySessionPost(req({ reason: "x" }), { params: { staffId: "target-1" } });
    expect(res.status).toBe(401);
    expect(mocks.issueNormalRecoverySession).not.toHaveBeenCalled();
  });
});

describe("AD-005 API-AD-028 break-glass recovery", () => {
  it("is pre-MFA — no admin guard is invoked at all", async () => {
    mocks.issueBreakGlassRecoverySession.mockResolvedValue({ recoverySessionId: "rs-1", pendingToken: "tok" });
    const res = await breakGlassPost(req({ email: "admin@example.com", password: "pw", recoveryCode: "AAAA-BBBB-CCCC-DDDD" }));
    expect(mocks.requireAdminApi).not.toHaveBeenCalled();
    expect(res.status).toBe(201);
  });

  it("rejects a malformed request before ever calling the service", async () => {
    const res = await breakGlassPost(req({ email: "admin@example.com" }));
    expect(res.status).toBe(400);
    expect(mocks.issueBreakGlassRecoverySession).not.toHaveBeenCalled();
  });
});

describe("AD-005 recovery/consume (target-facing, pre-MFA)", () => {
  it("exchanges email+password for a pendingToken with no admin guard", async () => {
    mocks.consumeRecoverySessionWithPassword.mockResolvedValue({ pendingToken: "tok" });
    const res = await consumePost(req({ email: "target@example.com", password: "pw" }));
    expect(mocks.requireAdminApi).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});

describe("AD-005 API-AD-029 recovery-code rotation", () => {
  it("requires the rotate capability + sensitive reauth", async () => {
    mocks.rotateRecoveryCodes.mockReturnValue({ codes: ["AAAA-BBBB-CCCC-DDDD"], generation: 2 });
    const res = await rotatePost();
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.platform.recovery_codes.rotate");
    expect(mocks.requireStaffSensitiveReauth).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
});

describe("AD-005 API-AD-030 privileged audit", () => {
  it("requires admin.platform.audit.read and rejects a missing time range", async () => {
    const res = await auditGet(new Request("https://example.test/v1/admin/platform/audit"));
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.platform.audit.read");
    expect(res.status).toBe(400);
    expect(mocks.queryPrivilegedAudit).not.toHaveBeenCalled();
  });

  it("passes only the allowlisted query params through", async () => {
    mocks.queryPrivilegedAudit.mockReturnValue({ events: [], nextCursor: null });
    const res = await auditGet(new Request("https://example.test/v1/admin/platform/audit?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z&staffId=s-1"));
    expect(mocks.queryPrivilegedAudit).toHaveBeenCalledWith(expect.objectContaining({ from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z", staffAccountId: "s-1" }));
    expect(res.status).toBe(200);
  });
});

describe("AD-005 API-AD-031 governance-gated parent restoration", () => {
  it("requires admin.account.restore + sensitive reauth and delegates to the governance layer", async () => {
    mocks.restoreAccountViaGovernance.mockReturnValue({ parentId: "parent-1", version: 2 });
    const res = await restorePost(req({
      parentId: "parent-1", reason: "Deletion confirmed accidental after the parent contacted support.",
      expectedVersion: 1, idempotencyKey: "k1", governanceReference: "incident-42",
    }));
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.account.restore");
    expect(mocks.requireStaffSensitiveReauth).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("rejects a malformed body before calling the governance layer", async () => {
    const res = await restorePost(req({ parentId: "parent-1" }));
    expect(res.status).toBe(400);
    expect(mocks.restoreAccountViaGovernance).not.toHaveBeenCalled();
  });
});
