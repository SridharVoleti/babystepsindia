// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isStaffSessionLive,
  signPendingStaffToken,
  signStaffSession,
  verifyPendingStaffToken,
  verifyStaffSessionToken,
  type StaffSessionPayload,
} from "@/lib/staff-identity/session";
import type { StaffAccountRow } from "@/lib/staff-identity/accounts-repo";

const now = new Date("2026-08-16T10:00:00.000Z");

function fixtureSession(overrides: Partial<StaffSessionPayload> = {}): StaffSessionPayload {
  return {
    staffAccountId: "staff-1",
    authUserId: "auth-1",
    sessionId: "session-1",
    authenticationTime: now.getTime(),
    mfaVerificationTime: now.getTime(),
    authorizationGeneration: 1,
    roleKeys: ["platform_administrator"],
    lastActivityTime: now.getTime(),
    ...overrides,
  };
}

function fixtureRow(overrides: Partial<StaffAccountRow> = {}): StaffAccountRow {
  return {
    id: "staff-1",
    auth_user_id: "auth-1",
    normalized_email: "staff@example.com",
    display_name: null,
    status: "active",
    authorization_generation: 1,
    invited_by_staff_id: null,
    invitation_expires_at: null,
    activated_at: now.toISOString(),
    suspended_at: null,
    revoked_at: null,
    version: 1,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  };
}

describe("AD-001 staff session", () => {
  it("round-trips a signed staff session token", async () => {
    process.env.AUTH_SECRET = "test-secret-at-least-32-bytes-long!!";
    const token = await signStaffSession(fixtureSession());
    const payload = await verifyStaffSessionToken(token);
    expect(payload?.staffAccountId).toBe("staff-1");
  });

  it("stays live within idle/absolute windows and a matching authorization generation", () => {
    expect(isStaffSessionLive(fixtureSession(), fixtureRow(), now)).toBe(true);
  });

  it("dies after the 30-minute idle timeout (business rule 22)", () => {
    const stale = new Date(now.getTime() + 30 * 60_000 + 1);
    expect(isStaffSessionLive(fixtureSession(), fixtureRow(), stale)).toBe(false);
  });

  it("dies after the 8-hour absolute lifetime even with recent activity (business rule 23)", () => {
    const eightHoursLater = new Date(now.getTime() + 8 * 60 * 60_000 + 1);
    const session = fixtureSession({ lastActivityTime: eightHoursLater.getTime() });
    expect(isStaffSessionLive(session, fixtureRow(), eightHoursLater)).toBe(false);
  });

  it("dies immediately on an authorization-generation mismatch, before either timeout (business rule 38)", () => {
    const session = fixtureSession({ authorizationGeneration: 1 });
    const row = fixtureRow({ authorization_generation: 2 });
    expect(isStaffSessionLive(session, row, now)).toBe(false);
  });

  it("dies for a suspended or revoked account regardless of session freshness", () => {
    expect(isStaffSessionLive(fixtureSession(), fixtureRow({ status: "suspended" }), now)).toBe(false);
    expect(isStaffSessionLive(fixtureSession(), fixtureRow({ status: "revoked" }), now)).toBe(false);
  });

  it("round-trips a pending staff token carrying purpose and staffAccountId", async () => {
    process.env.AUTH_SECRET = "test-secret-at-least-32-bytes-long!!";
    const token = await signPendingStaffToken({ staffAccountId: "staff-9", purpose: "enrollment" });
    const payload = await verifyPendingStaffToken(token);
    expect(payload).toMatchObject({ staffAccountId: "staff-9", purpose: "enrollment" });
  });
});
