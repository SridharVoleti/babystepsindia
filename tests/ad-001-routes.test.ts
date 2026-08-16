// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminApi: vi.fn(),
  requireStaffSensitiveReauth: vi.fn(),
  createInvitation: vi.fn(),
  findStaffById: vi.fn(),
  isSuperAdminDisplay: vi.fn(),
  listStaff: vi.fn(),
  changeStaffStatus: vi.fn(),
  assignStaffRoles: vi.fn(),
  verifyPendingStaffToken: vi.fn(),
  setStaffSessionCookie: vi.fn(),
  completeStaffLogin: vi.fn(),
  recordReauthReceipt: vi.fn(),
  verifyStaffPasskeyAssertion: vi.fn(),
  generateStaffPasskeyRegistrationOptions: vi.fn(),
  verifyStaffPasskeyRegistration: vi.fn(),
  beginStaffLogin: vi.fn(),
  beginStaffReauth: vi.fn(),
  generateStaffPasskeyAssertionOptions: vi.fn(),
  createRefundCase: vi.fn(),
  confirmProviderRefund: vi.fn(),
  restoreAccount: vi.fn(),
  parentProfileFind: vi.fn(),
}));

vi.mock("@/lib/staff-identity/guard", () => ({
  requireAdminApi: mocks.requireAdminApi,
  requireStaffSensitiveReauth: mocks.requireStaffSensitiveReauth,
}));
vi.mock("@/lib/staff-identity/invitation-service", () => ({ createInvitation: mocks.createInvitation }));
vi.mock("@/lib/staff-identity/accounts-repo", () => ({ findStaffById: mocks.findStaffById, listStaff: mocks.listStaff }));
vi.mock("@/lib/staff-identity/roles", () => ({ isSuperAdminDisplay: mocks.isSuperAdminDisplay }));
vi.mock("@/lib/staff-identity/status-service", () => ({ changeStaffStatus: mocks.changeStaffStatus }));
vi.mock("@/lib/staff-identity/roles-service", () => ({ assignStaffRoles: mocks.assignStaffRoles }));
vi.mock("@/lib/staff-identity/session", () => ({
  verifyPendingStaffToken: mocks.verifyPendingStaffToken,
  setStaffSessionCookie: mocks.setStaffSessionCookie,
}));
vi.mock("@/lib/staff-identity/auth-service", () => ({
  completeStaffLogin: mocks.completeStaffLogin,
  beginStaffLogin: mocks.beginStaffLogin,
  beginStaffReauth: mocks.beginStaffReauth,
}));
vi.mock("@/lib/staff-identity/reauth-service", () => ({ recordReauthReceipt: mocks.recordReauthReceipt }));
vi.mock("@/lib/webauthn/staff-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/webauthn/staff-service")>()),
  verifyStaffPasskeyAssertion: mocks.verifyStaffPasskeyAssertion,
  generateStaffPasskeyRegistrationOptions: mocks.generateStaffPasskeyRegistrationOptions,
  verifyStaffPasskeyRegistration: mocks.verifyStaffPasskeyRegistration,
  generateStaffPasskeyAssertionOptions: mocks.generateStaffPasskeyAssertionOptions,
}));
vi.mock("@/lib/billing/bi005-service", () => ({
  createRefundCase: mocks.createRefundCase,
  confirmProviderRefund: mocks.confirmProviderRefund,
}));
vi.mock("@/lib/db/account-security-repo", () => ({ restoreAccount: mocks.restoreAccount }));
vi.mock("@/lib/db/parent-profile-store", () => ({ sqliteParentProfileStore: { find: mocks.parentProfileFind } }));

import { POST as invitationsPost } from "@/app/v1/admin/staff/invitations/route";
import { GET as sessionContextGet } from "@/app/v1/admin/session-context/route";
import { GET as staffListGet } from "@/app/v1/admin/staff/route";
import { PATCH as statusPatch } from "@/app/v1/admin/staff/[staffId]/status/route";
import { PUT as rolesPut } from "@/app/v1/admin/staff/[staffId]/roles/route";
import { POST as registrationOptionsPost } from "@/app/v1/admin/auth/passkey/registration-options/route";
import { POST as registerPost } from "@/app/v1/admin/auth/passkey/register/route";
import { POST as assertionOptionsPost } from "@/app/v1/admin/auth/passkey/assertion-options/route";
import { POST as verifyPost } from "@/app/v1/admin/auth/passkey/verify/route";
import { POST as refundCreatePost } from "@/app/v1/admin/billing/refund-cases/route";
import { POST as refundConfirmPost } from "@/app/v1/admin/billing/refund-cases/[caseId]/confirm/route";
import { POST as restorePost } from "@/app/v1/admin/accounts/[parentId]/restore/route";

function req(body: unknown, method = "POST") {
  return new Request("https://example.test", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
}

const okSession = { staffAccountId: "staff-1", sessionId: "session-1", roleKeys: ["platform_administrator"], authenticationTime: 1, mfaVerificationTime: 1, authorizationGeneration: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdminApi.mockResolvedValue({ ok: true, session: okSession });
  mocks.requireStaffSensitiveReauth.mockReturnValue(null);
});

describe("AD-001 API routes", () => {
  it("API-AD-001 creates a staff invitation after guard + reauth pass", async () => {
    mocks.createInvitation.mockReturnValue({ staffAccountId: "new-staff", expiresAt: "2026-08-17T10:00:00.000Z" });
    const reason = "Onboarding a new staff member per manager approval on this ticket.";
    const res = await invitationsPost(req({ email: "new@example.com", initialRoleKeys: ["support_agent"], reason }));
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.staff.invitation.create");
    expect(mocks.requireStaffSensitiveReauth).toHaveBeenCalledWith(okSession);
    expect(mocks.createInvitation).toHaveBeenCalledWith({ byStaffId: "staff-1", email: "new@example.com", initialRoleKeys: ["support_agent"], reason });
    expect(res.status).toBe(201);
  });

  it("API-AD-001 rejects an invalid role key before calling the service", async () => {
    const res = await invitationsPost(req({ email: "new@example.com", initialRoleKeys: ["not_a_role"],
      reason: "Onboarding a new staff member per manager approval on this ticket." }));
    expect(res.status).toBe(400);
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });

  it("API-AD-001 fails closed when reauth is missing", async () => {
    mocks.requireStaffSensitiveReauth.mockReturnValue(new Response(JSON.stringify({ error: "REAUTHENTICATION_REQUIRED" }), { status: 401 }));
    const res = await invitationsPost(req({ email: "new@example.com", initialRoleKeys: ["support_agent"],
      reason: "Onboarding a new staff member per manager approval on this ticket." }));
    expect(res.status).toBe(401);
    expect(mocks.createInvitation).not.toHaveBeenCalled();
  });

  it("API-AD-002 returns the current staff session context, never a client-supplied claim", async () => {
    mocks.findStaffById.mockReturnValue({ id: "staff-1", display_name: "Ada Admin", normalized_email: "ada@example.com" });
    mocks.isSuperAdminDisplay.mockReturnValue(false);
    const res = await sessionContextGet();
    const body = await res.json();
    expect(body).toMatchObject({ staffAccountId: "staff-1", roles: ["platform_administrator"], isSuperAdmin: false });
    expect(body.emailHint).not.toBe("ada@example.com");
  });

  it("API-AD-009 lists staff via the requested filters", async () => {
    mocks.listStaff.mockReturnValue({ staff: [], nextCursor: null });
    const res = await staffListGet(new Request("https://example.test/v1/admin/staff?status=active&limit=10"));
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.staff.list.read");
    expect(mocks.listStaff).toHaveBeenCalledWith({ cursor: undefined, status: "active", limit: 10 });
    expect(res.status).toBe(200);
  });

  it("API-AD-007 changes staff status through the guard + reauth + service chain", async () => {
    mocks.changeStaffStatus.mockReturnValue({ staffAccountId: "target-1", status: "suspended", version: 2 });
    const res = await statusPatch(req({ status: "suspended", reason: "x".repeat(25), expectedVersion: 1, idempotencyKey: "k1" }, "PATCH"), { params: { staffId: "target-1" } });
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.staff.status.update");
    expect(mocks.changeStaffStatus).toHaveBeenCalledWith({ actorStaffId: "staff-1", targetStaffId: "target-1", newStatus: "suspended", reason: "x".repeat(25), expectedVersion: 1, idempotencyKey: "k1" });
    expect(res.status).toBe(200);
  });

  it("API-AD-008 assigns roles through the guard + reauth + service chain", async () => {
    mocks.assignStaffRoles.mockReturnValue({ staffAccountId: "target-1", roleKeys: ["billing_administrator"], version: 2 });
    const res = await rolesPut(req({ roleKeys: ["billing_administrator"], reason: "x".repeat(25), expectedVersion: 1, idempotencyKey: "k2" }), { params: { staffId: "target-1" } });
    expect(mocks.assignStaffRoles).toHaveBeenCalledWith({ actorStaffId: "staff-1", targetStaffId: "target-1", roleKeys: ["billing_administrator"], reason: "x".repeat(25), expectedVersion: 1, idempotencyKey: "k2" });
    expect(res.status).toBe(200);
  });

  it("API-AD-003 resolves the enrollment pendingToken path without a full session", async () => {
    mocks.verifyPendingStaffToken.mockResolvedValue({ staffAccountId: "staff-2", purpose: "enrollment" });
    mocks.findStaffById.mockReturnValue({ id: "staff-2", display_name: null, normalized_email: "s2@example.com" });
    mocks.generateStaffPasskeyRegistrationOptions.mockResolvedValue({ challengeId: "c1", options: {} });
    const res = await registrationOptionsPost(req({ pendingToken: "tok" }));
    expect(mocks.requireAdminApi).not.toHaveBeenCalled();
    expect(mocks.generateStaffPasskeyRegistrationOptions).toHaveBeenCalledWith({ staffAccountId: "staff-2", displayName: "s2@example.com" });
    expect(res.status).toBe(200);
  });

  it("API-AD-003 falls back to guard + reauth for an already-authenticated staff adding another passkey", async () => {
    mocks.findStaffById.mockReturnValue({ id: "staff-1", display_name: "Ada", normalized_email: "ada@example.com" });
    mocks.generateStaffPasskeyRegistrationOptions.mockResolvedValue({ challengeId: "c2", options: {} });
    const res = await registrationOptionsPost(req({}));
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.staff.passkey.registration_options");
    expect(mocks.requireStaffSensitiveReauth).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("API-AD-004 stores a credential from a valid enrollment pendingToken", async () => {
    mocks.verifyPendingStaffToken.mockResolvedValue({ staffAccountId: "staff-2", purpose: "enrollment" });
    mocks.verifyStaffPasskeyRegistration.mockResolvedValue({ id: "cred-1", credentialId: "abc", label: "Key" });
    const res = await registerPost(req({ pendingToken: "tok", challengeId: "c1", label: "Key", response: {} }));
    expect(res.status).toBe(200);
  });

  it("API-AD-004 rejects a non-enrollment pending token with no full session", async () => {
    mocks.verifyPendingStaffToken.mockResolvedValue(null);
    const res = await registerPost(req({ pendingToken: "bad", challengeId: "c1", label: "Key", response: {} }));
    expect(res.status).toBe(401);
    expect(mocks.verifyStaffPasskeyRegistration).not.toHaveBeenCalled();
  });

  it("API-AD-005 login flow returns enrollment purpose with no challenge when no passkey exists yet", async () => {
    mocks.beginStaffLogin.mockResolvedValue({ staffAccountId: "staff-2", purpose: "enrollment", pendingToken: "tok" });
    const res = await assertionOptionsPost(req({ email: "s2@example.com", password: "CorrectHorse1!" }));
    const body = await res.json();
    expect(body).toEqual({ pendingToken: "tok", purpose: "enrollment" });
    expect(mocks.generateStaffPasskeyAssertionOptions).not.toHaveBeenCalled();
  });

  it("API-AD-005 login flow issues an assertion challenge when a passkey exists", async () => {
    mocks.beginStaffLogin.mockResolvedValue({ staffAccountId: "staff-2", purpose: "login", pendingToken: "tok" });
    mocks.generateStaffPasskeyAssertionOptions.mockResolvedValue({ challengeId: "c3", options: {} });
    const res = await assertionOptionsPost(req({ email: "s2@example.com", password: "CorrectHorse1!" }));
    expect(mocks.generateStaffPasskeyAssertionOptions).toHaveBeenCalledWith({ staffAccountId: "staff-2", purpose: "login" });
    expect(res.status).toBe(200);
  });

  it("API-AD-005 reauth flow requires a full session and the current password", async () => {
    mocks.beginStaffReauth.mockResolvedValue({ pendingToken: "tok" });
    mocks.generateStaffPasskeyAssertionOptions.mockResolvedValue({ challengeId: "c4", options: {} });
    const res = await assertionOptionsPost(req({ currentPassword: "CorrectHorse1!" }));
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.staff.passkey.assertion_options");
    expect(mocks.beginStaffReauth).toHaveBeenCalledWith({ staffAccountId: "staff-1", staffSessionId: "session-1", currentPassword: "CorrectHorse1!" });
    expect(res.status).toBe(200);
  });

  it("API-AD-006 completes login and sets the staff session cookie", async () => {
    mocks.verifyPendingStaffToken.mockResolvedValue({ staffAccountId: "staff-2", purpose: "login" });
    mocks.verifyStaffPasskeyAssertion.mockResolvedValue({ credentialId: "abc" });
    mocks.completeStaffLogin.mockResolvedValue({ token: "jwt", payload: { staffAccountId: "staff-2" } });
    const res = await verifyPost(req({ pendingToken: "tok", challengeId: "c1", response: {} }));
    expect(mocks.setStaffSessionCookie).toHaveBeenCalledWith({ staffAccountId: "staff-2" });
    const body = await res.json();
    expect(body).toEqual({ ok: true, purpose: "login" });
  });

  it("API-AD-006 records a reauth receipt for the bound session instead of issuing a new session", async () => {
    mocks.verifyPendingStaffToken.mockResolvedValue({ staffAccountId: "staff-1", purpose: "reauth", staffSessionId: "session-1" });
    mocks.verifyStaffPasskeyAssertion.mockResolvedValue({ credentialId: "abc" });
    const res = await verifyPost(req({ pendingToken: "tok", challengeId: "c1", response: {} }));
    expect(mocks.recordReauthReceipt).toHaveBeenCalledWith({ staffSessionId: "session-1", staffAccountId: "staff-1" });
    expect(mocks.setStaffSessionCookie).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body).toEqual({ ok: true, purpose: "reauth" });
  });

  it("wraps BI-005's refund-case creation behind Billing Administrator capability + reauth", async () => {
    mocks.createRefundCase.mockReturnValue({ id: "refund-1", status: "pending_provider_confirmation" });
    const res = await refundCreatePost(req({ subscriptionId: "sub-1", refundType: "full", reasonCategory: "duplicate_charge" }));
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.billing.refund.create");
    expect(mocks.requireStaffSensitiveReauth).toHaveBeenCalled();
    expect(mocks.createRefundCase).toHaveBeenCalledWith("staff-1", expect.objectContaining({ subscriptionId: "sub-1", refundType: "full" }));
    expect(res.status).toBe(201);
  });

  it("wraps BI-005's provider-refund confirmation behind Billing Administrator capability + reauth", async () => {
    mocks.confirmProviderRefund.mockReturnValue({ id: "refund-1", status: "confirmed" });
    const res = await refundConfirmPost(req({ expectedVersion: 1, idempotencyKey: "k3" }), { params: { caseId: "refund-1" } });
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.billing.refund.confirm");
    expect(mocks.confirmProviderRefund).toHaveBeenCalledWith("staff-1", "refund-1", { expectedVersion: 1, idempotencyKey: "k3" });
    expect(res.status).toBe(200);
  });

  it("IA-003 restore now requires Platform Administrator capability + sensitive reauth instead of a raw isAdmin check", async () => {
    mocks.parentProfileFind.mockResolvedValue({ id: "parent-1" });
    const res = await restorePost(req({ reason: "Reversing an accidental deletion." }), { params: { parentId: "parent-1" } });
    expect(mocks.requireAdminApi).toHaveBeenCalledWith("admin.account.restore");
    expect(mocks.requireStaffSensitiveReauth).toHaveBeenCalled();
    expect(mocks.restoreAccount).toHaveBeenCalledWith("parent-1", "staff-1", "Reversing an accidental deletion.");
    expect(res.status).toBe(200);
  });

  it("IA-003 restore fails closed when reauth is missing", async () => {
    mocks.requireStaffSensitiveReauth.mockReturnValue(new Response(JSON.stringify({ error: "REAUTHENTICATION_REQUIRED" }), { status: 401 }));
    const res = await restorePost(req({ reason: "x" }), { params: { parentId: "parent-1" } });
    expect(res.status).toBe(401);
    expect(mocks.restoreAccount).not.toHaveBeenCalled();
  });
});
