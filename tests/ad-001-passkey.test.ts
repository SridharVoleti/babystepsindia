// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { ensureBootstrapPlatformAdmin } from "./helpers/staff-session-fixture";
import {
  activeStaffPasskeyCount,
  generateStaffPasskeyAssertionOptions,
  generateStaffPasskeyRegistrationOptions,
  listStaffPasskeys,
  revokeStaffPasskey,
  StaffWebAuthnError,
  verifyStaffPasskeyAssertion,
  verifyStaffPasskeyRegistration,
} from "@/lib/webauthn/staff-service";
import { buildAuthenticationResponse, buildRegistrationResponse, createVirtualAuthenticator } from "./helpers/webauthn-virtual-authenticator";

const now = new Date("2026-08-16T10:00:00.000Z");
const rpID = "localhost";
const origin = "http://localhost";

beforeEach(() => {
  useInMemoryDb();
  process.env.WEBAUTHN_RP_ID = rpID;
  process.env.WEBAUTHN_RP_NAME = "BabySteps Test";
  process.env.WEBAUTHN_ORIGIN = origin;
});

function bootstrapAdmin() {
  return ensureBootstrapPlatformAdmin(now);
}

async function registerPasskey(staffAccountId: string) {
  const { challengeId, options } = await generateStaffPasskeyRegistrationOptions(
    { staffAccountId, displayName: "Bootstrap Administrator" },
    now,
  );
  const authenticator = createVirtualAuthenticator();
  const response = buildRegistrationResponse(authenticator, { rpID, origin, challenge: options.challenge });
  const credential = await verifyStaffPasskeyRegistration({ staffAccountId, challengeId, response, label: "YubiKey" }, now);
  return { authenticator, credential };
}

describe("AD-001 staff WebAuthn passkeys", () => {
  it("registers a real staff passkey credential end-to-end via the virtual authenticator", async () => {
    const staffAccountId = bootstrapAdmin();
    const { credential } = await registerPasskey(staffAccountId);
    expect(credential.label).toBe("YubiKey");
    expect(await activeStaffPasskeyCount(staffAccountId)).toBe(1);
    expect((await listStaffPasskeys(staffAccountId))[0]).toMatchObject({ label: "YubiKey", status: "active" });
  });

  it("rejects registration replay of an already-consumed challenge", async () => {
    const staffAccountId = bootstrapAdmin();
    const { challengeId, options } = await generateStaffPasskeyRegistrationOptions(
      { staffAccountId, displayName: "Bootstrap Administrator" },
      now,
    );
    const authenticator = createVirtualAuthenticator();
    const response = buildRegistrationResponse(authenticator, { rpID, origin, challenge: options.challenge });
    await verifyStaffPasskeyRegistration({ staffAccountId, challengeId, response, label: "First" }, now);
    await expect(verifyStaffPasskeyRegistration({ staffAccountId, challengeId, response, label: "Replay" }, now)).rejects.toEqual(
      new StaffWebAuthnError("WEBAUTHN_CHALLENGE_INVALID"),
    );
  });

  it("fails closed when no passkey is registered yet for a login assertion", async () => {
    const staffAccountId = bootstrapAdmin();
    await expect(generateStaffPasskeyAssertionOptions({ staffAccountId, purpose: "login" }, now)).rejects.toEqual(
      new StaffWebAuthnError("NO_PASSKEY_REGISTERED"),
    );
  });

  it("verifies a login assertion and advances the stored sign counter", async () => {
    const staffAccountId = bootstrapAdmin();
    const { authenticator, credential } = await registerPasskey(staffAccountId);
    const { challengeId, options } = await generateStaffPasskeyAssertionOptions({ staffAccountId, purpose: "login" }, now);
    const response = buildAuthenticationResponse(authenticator, { rpID, origin, challenge: options.challenge, signCount: 7 });
    const result = await verifyStaffPasskeyAssertion({ staffAccountId, purpose: "login", challengeId, response }, now);
    expect(result.credentialId).toBeTruthy();
    const row = getDb().prepare("select sign_count from staff_passkey_credentials where id=?").get(credential.id) as {
      sign_count: number;
    };
    expect(row.sign_count).toBe(7);
  });

  it("revokes a cloned authenticator whose signature counter fails to advance", async () => {
    const staffAccountId = bootstrapAdmin();
    const { authenticator, credential } = await registerPasskey(staffAccountId);
    const first = await generateStaffPasskeyAssertionOptions({ staffAccountId, purpose: "login" }, now);
    await verifyStaffPasskeyAssertion(
      { staffAccountId, purpose: "login", challengeId: first.challengeId,
        response: buildAuthenticationResponse(authenticator, { rpID, origin, challenge: first.options.challenge, signCount: 5 }) },
      now,
    );
    const second = await generateStaffPasskeyAssertionOptions({ staffAccountId, purpose: "login" }, now);
    await expect(
      verifyStaffPasskeyAssertion(
        { staffAccountId, purpose: "login", challengeId: second.challengeId,
          response: buildAuthenticationResponse(authenticator, { rpID, origin, challenge: second.options.challenge, signCount: 5 }) },
        now,
      ),
    ).rejects.toEqual(new StaffWebAuthnError("WEBAUTHN_CLONE_SUSPECTED"));
    const row = getDb().prepare("select status from staff_passkey_credentials where id=?").get(credential.id) as { status: string };
    expect(row.status).toBe("revoked");
  });

  it("rejects an assertion signed by the wrong RP/origin", async () => {
    const staffAccountId = bootstrapAdmin();
    const { authenticator } = await registerPasskey(staffAccountId);
    const { challengeId, options } = await generateStaffPasskeyAssertionOptions({ staffAccountId, purpose: "login" }, now);
    const response = buildAuthenticationResponse(authenticator, {
      rpID: "attacker.example", origin: "http://attacker.example", challenge: options.challenge, signCount: 1,
    });
    await expect(verifyStaffPasskeyAssertion({ staffAccountId, purpose: "login", challengeId, response }, now)).rejects.toEqual(
      new StaffWebAuthnError("WEBAUTHN_AUTHENTICATION_INVALID"),
    );
  });

  it("keeps a reauth-purpose challenge separate from a login-purpose challenge (cannot be consumed cross-purpose)", async () => {
    const staffAccountId = bootstrapAdmin();
    const { authenticator } = await registerPasskey(staffAccountId);
    const { challengeId, options } = await generateStaffPasskeyAssertionOptions({ staffAccountId, purpose: "reauth" }, now);
    const response = buildAuthenticationResponse(authenticator, { rpID, origin, challenge: options.challenge, signCount: 2 });
    // Attempting to consume a reauth-purpose challenge as a login verify fails closed.
    await expect(verifyStaffPasskeyAssertion({ staffAccountId, purpose: "login", challengeId, response }, now)).rejects.toEqual(
      new StaffWebAuthnError("WEBAUTHN_CHALLENGE_INVALID"),
    );
    // The correct purpose still works.
    const result = await verifyStaffPasskeyAssertion({ staffAccountId, purpose: "reauth", challengeId, response }, now);
    expect(result.credentialId).toBeTruthy();
  });

  it("lets a staff member revoke one of several passkeys", async () => {
    const staffAccountId = bootstrapAdmin();
    const { credential } = await registerPasskey(staffAccountId);
    const result = await revokeStaffPasskey({ staffAccountId, credentialRowId: credential.id, now });
    expect(result.revoked).toBe(true);
    expect(await activeStaffPasskeyCount(staffAccountId)).toBe(0);
  });
});
