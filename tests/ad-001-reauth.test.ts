// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { ensureBootstrapPlatformAdmin } from "./helpers/staff-session-fixture";
import { beginStaffLogin, beginStaffReauth, completeStaffLogin } from "@/lib/staff-identity/auth-service";
import { verifyPendingStaffToken } from "@/lib/staff-identity/session";
import { StaffIdentityError } from "@/lib/staff-identity/errors";
import { recordReauthReceipt, requireSensitiveReauth } from "@/lib/staff-identity/reauth-service";
import {
  generateStaffPasskeyAssertionOptions,
  generateStaffPasskeyRegistrationOptions,
  verifyStaffPasskeyAssertion,
  verifyStaffPasskeyRegistration,
} from "@/lib/webauthn/staff-service";
import { buildAuthenticationResponse, buildRegistrationResponse, createVirtualAuthenticator } from "./helpers/webauthn-virtual-authenticator";

const now = new Date("2026-08-16T10:00:00.000Z");
const rpID = "localhost";
const origin = "http://localhost";
const BOOTSTRAP_PASSWORD = "changeme123";

beforeEach(() => {
  useInMemoryDb();
  process.env.AUTH_SECRET = "test-secret-at-least-32-bytes-long!!";
  process.env.WEBAUTHN_RP_ID = rpID;
  process.env.WEBAUTHN_RP_NAME = "BabySteps Test";
  process.env.WEBAUTHN_ORIGIN = origin;
});

async function fixtureWithPasskey() {
  const staffAccountId = ensureBootstrapPlatformAdmin(now);
  const { challengeId, options } = await generateStaffPasskeyRegistrationOptions(
    { staffAccountId, displayName: "Bootstrap Administrator" },
    now,
  );
  const authenticator = createVirtualAuthenticator();
  const response = buildRegistrationResponse(authenticator, { rpID, origin, challenge: options.challenge });
  await verifyStaffPasskeyRegistration({ staffAccountId, challengeId, response, label: "YubiKey" }, now);
  return { staffAccountId, authenticator };
}

describe("AD-001 staff login and sensitive reauth", () => {
  it("rejects login with the wrong password (business rule 101, generic failure)", async () => {
    ensureBootstrapPlatformAdmin(now);
    await expect(beginStaffLogin({ email: "admin@babysteps.in", password: "wrong-password", now })).rejects.toEqual(
      new StaffIdentityError("INVALID_CREDENTIALS"),
    );
  });

  it("routes a first-time staff member (no passkey yet) to enrollment, not login", async () => {
    ensureBootstrapPlatformAdmin(now);
    const result = await beginStaffLogin({ email: "admin@babysteps.in", password: BOOTSTRAP_PASSWORD, now });
    expect(result.purpose).toBe("enrollment");
    const token = await verifyPendingStaffToken(result.pendingToken);
    expect(token?.staffAccountId).toBe(result.staffAccountId);
  });

  it("routes a staff member with a registered passkey to login, not enrollment", async () => {
    const { staffAccountId } = await fixtureWithPasskey();
    const result = await beginStaffLogin({ email: "admin@babysteps.in", password: BOOTSTRAP_PASSWORD, now });
    expect(result.purpose).toBe("login");
    expect(result.staffAccountId).toBe(staffAccountId);
  });

  it("completes MFA login end-to-end and issues a full staff session after password + passkey both succeed", async () => {
    const { staffAccountId, authenticator } = await fixtureWithPasskey();
    const begin = await beginStaffLogin({ email: "admin@babysteps.in", password: BOOTSTRAP_PASSWORD, now });
    expect(begin.purpose).toBe("login");
    const { challengeId, options } = await generateStaffPasskeyAssertionOptions({ staffAccountId, purpose: "login" }, now);
    const response = buildAuthenticationResponse(authenticator, { rpID, origin, challenge: options.challenge, signCount: 1 });
    await verifyStaffPasskeyAssertion({ staffAccountId, purpose: "login", challengeId, response }, now);
    const session = await completeStaffLogin({ staffAccountId, now });
    expect(session.payload.roleKeys).toContain("platform_administrator");
    expect(session.payload.authenticationTime).toBe(now.getTime());
  });

  it("fails closed for a sensitive action with no reauth receipt", async () => {
    await expect(requireSensitiveReauth({ staffSessionId: "session-1", staffAccountId: "staff-1", now })).rejects.toEqual(
      new StaffIdentityError("REAUTHENTICATION_REQUIRED"),
    );
  });

  it("re-verifies the current password before issuing a reauth passkey challenge (business rule 61)", async () => {
    const { staffAccountId } = await fixtureWithPasskey();
    await expect(
      beginStaffReauth({ staffAccountId, staffSessionId: "session-1", currentPassword: "wrong", now }),
    ).rejects.toEqual(new StaffIdentityError("REAUTHENTICATION_REQUIRED"));
  });

  it("completes a full two-factor reauth ceremony and satisfies requireSensitiveReauth within the 10-minute window", async () => {
    const { staffAccountId, authenticator } = await fixtureWithPasskey();
    const begin = await beginStaffReauth({ staffAccountId, staffSessionId: "session-1", currentPassword: BOOTSTRAP_PASSWORD, now });
    expect(begin.pendingToken).toBeTruthy();
    const { challengeId, options } = await generateStaffPasskeyAssertionOptions({ staffAccountId, purpose: "reauth" }, now);
    const response = buildAuthenticationResponse(authenticator, { rpID, origin, challenge: options.challenge, signCount: 2 });
    await verifyStaffPasskeyAssertion({ staffAccountId, purpose: "reauth", challengeId, response }, now);
    await recordReauthReceipt({ staffSessionId: "session-1", staffAccountId, now });

    await expect(requireSensitiveReauth({ staffSessionId: "session-1", staffAccountId, now })).resolves.toBeUndefined();
    // Business rule 60/67: a different session never inherits this receipt.
    await expect(requireSensitiveReauth({ staffSessionId: "session-2", staffAccountId, now })).rejects.toEqual(
      new StaffIdentityError("REAUTHENTICATION_REQUIRED"),
    );
  });

  it("expires the reauth receipt after 10 minutes (business rule 61)", async () => {
    const staffAccountId = ensureBootstrapPlatformAdmin(now);
    await recordReauthReceipt({ staffSessionId: "session-1", staffAccountId, now });
    const later = new Date(now.getTime() + 10 * 60_000 + 1);
    await expect(requireSensitiveReauth({ staffSessionId: "session-1", staffAccountId, now: later })).rejects.toEqual(
      new StaffIdentityError("REAUTHENTICATION_REQUIRED"),
    );
  });
});
