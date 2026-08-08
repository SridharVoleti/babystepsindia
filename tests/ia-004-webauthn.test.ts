// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { selectLearner } from "@/lib/learning-session/gateway";
import { AuthorizationModeError, deriveAuthorizationContext } from "@/lib/authorization/modes";
import {
  generatePasskeyAuthenticationOptions,
  generatePasskeyRegistrationOptions,
  listLearnerPasskeys,
  revokeLearnerPasskey,
  verifyPasskeyAuthenticationAndEnterLearnerMode,
  verifyPasskeyRegistration,
  WebAuthnError,
} from "@/lib/webauthn/service";
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createVirtualAuthenticator,
} from "./helpers/webauthn-virtual-authenticator";

const now = new Date("2026-08-09T10:00:00.000Z");
const rpID = "localhost";
const origin = "http://localhost";

beforeEach(() => {
  useInMemoryDb();
  process.env.WEBAUTHN_RP_ID = rpID;
  process.env.WEBAUTHN_RP_NAME = "BabySteps Test";
  process.env.WEBAUTHN_ORIGIN = origin;
});

async function fixture() {
  const { user } = await sqliteAuthAdapter.signUp("passkey-parent@example.com", "CorrectHorse1!");
  getDb().prepare("update profiles set onboarding_status='complete' where id=?").run(user.id);
  const learner = createLearner(user.id, {
    displayName: "Asha", dateOfBirth: "2018-01-01", idempotencyKey: crypto.randomUUID(),
  }, "2026-08-09").learner;
  selectLearner("parent-session-1", user.id, learner.id, "2026-08-10T00:00:00.000Z");
  return { user, learner };
}

async function registerPasskey(user: { id: string }, learner: { id: string }) {
  const actor = { parentUserId: user.id, parentSessionId: "parent-session-1", deviceSessionId: "device-1", learnerId: learner.id };
  const { challengeId, options } = await generatePasskeyRegistrationOptions(actor, now);
  const authenticator = createVirtualAuthenticator();
  const response = buildRegistrationResponse(authenticator, { rpID, origin, challenge: options.challenge });
  const credential = await verifyPasskeyRegistration({ ...actor, challengeId, response, label: "Family iPad" }, now);
  return { authenticator, credential, actor };
}

describe("IA-004 WebAuthn passkeys", () => {
  it("registers a real passkey credential end-to-end via the virtual authenticator", async () => {
    const { user, learner } = await fixture();
    const { credential } = await registerPasskey(user, learner);
    expect(credential.label).toBe("Family iPad");
    const rows = listLearnerPasskeys(user.id, learner.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "Family iPad", status: "active" });
  });

  it("rejects registration replay of an already-consumed challenge", async () => {
    const { user, learner } = await fixture();
    const actor = { parentUserId: user.id, parentSessionId: "parent-session-1", deviceSessionId: "device-1", learnerId: learner.id };
    const { challengeId, options } = await generatePasskeyRegistrationOptions(actor, now);
    const authenticator = createVirtualAuthenticator();
    const response = buildRegistrationResponse(authenticator, { rpID, origin, challenge: options.challenge });
    await verifyPasskeyRegistration({ ...actor, challengeId, response, label: "First" }, now);
    await expect(verifyPasskeyRegistration({ ...actor, challengeId, response, label: "Replay" }, now))
      .rejects.toEqual(new WebAuthnError("WEBAUTHN_CHALLENGE_INVALID"));
  });

  it("rejects a registration challenge older than 5 minutes", async () => {
    const { user, learner } = await fixture();
    const actor = { parentUserId: user.id, parentSessionId: "parent-session-1", deviceSessionId: "device-1", learnerId: learner.id };
    const { challengeId, options } = await generatePasskeyRegistrationOptions(actor, now);
    const authenticator = createVirtualAuthenticator();
    const response = buildRegistrationResponse(authenticator, { rpID, origin, challenge: options.challenge });
    const later = new Date(now.getTime() + 5 * 60_000 + 1);
    await expect(verifyPasskeyRegistration({ ...actor, challengeId, response, label: "Late" }, later))
      .rejects.toEqual(new WebAuthnError("WEBAUTHN_CHALLENGE_INVALID"));
  });

  it("fails closed when no passkey is registered yet for authentication", async () => {
    const { user, learner } = await fixture();
    const actor = { parentUserId: user.id, parentSessionId: "parent-session-1", deviceSessionId: "device-1", learnerId: learner.id };
    await expect(generatePasskeyAuthenticationOptions(actor, now)).rejects.toEqual(new WebAuthnError("NO_PASSKEY_REGISTERED"));
  });

  it("authenticates with the registered passkey and atomically activates learner mode", async () => {
    const { user, learner } = await fixture();
    const { authenticator, actor } = await registerPasskey(user, learner);
    const { challengeId, options } = await generatePasskeyAuthenticationOptions(actor, now);
    const response = buildAuthenticationResponse(authenticator, { rpID, origin, challenge: options.challenge, signCount: 1 });
    const context = await verifyPasskeyAuthenticationAndEnterLearnerMode({ ...actor, challengeId, response }, now);
    expect(context).toMatchObject({ mode: "learner_mode", learnerId: learner.id });
    const derived = deriveAuthorizationContext({ parentUserId: user.id, parentSessionId: "parent-session-1",
      deviceSessionId: "device-1", now });
    expect(derived.mode).toBe("learner_mode");
  });

  it("advances the stored sign counter after a successful authentication", async () => {
    const { user, learner } = await fixture();
    const { authenticator, actor, credential } = await registerPasskey(user, learner);
    const { challengeId, options } = await generatePasskeyAuthenticationOptions(actor, now);
    const response = buildAuthenticationResponse(authenticator, { rpID, origin, challenge: options.challenge, signCount: 7 });
    await verifyPasskeyAuthenticationAndEnterLearnerMode({ ...actor, challengeId, response }, now);
    const row = getDb().prepare("select sign_count from learner_passkey_credentials where id=?").get(credential.id) as { sign_count: number };
    expect(row.sign_count).toBe(7);
  });

  it("revokes a cloned authenticator whose signature counter fails to advance", async () => {
    const { user, learner } = await fixture();
    const { authenticator, actor, credential } = await registerPasskey(user, learner);
    const first = await generatePasskeyAuthenticationOptions(actor, now);
    await verifyPasskeyAuthenticationAndEnterLearnerMode({ ...actor, challengeId: first.challengeId,
      response: buildAuthenticationResponse(authenticator, { rpID, origin, challenge: first.options.challenge, signCount: 5 }) }, now);

    const second = await generatePasskeyAuthenticationOptions(actor, now);
    await expect(verifyPasskeyAuthenticationAndEnterLearnerMode({ ...actor, challengeId: second.challengeId,
      response: buildAuthenticationResponse(authenticator, { rpID, origin, challenge: second.options.challenge, signCount: 5 }) }, now))
      .rejects.toEqual(new WebAuthnError("WEBAUTHN_CLONE_SUSPECTED"));

    const row = getDb().prepare("select status from learner_passkey_credentials where id=?").get(credential.id) as { status: string };
    expect(row.status).toBe("revoked");
  });

  it("rejects an assertion signed by the wrong RP/origin", async () => {
    const { user, learner } = await fixture();
    const { authenticator, actor } = await registerPasskey(user, learner);
    const { challengeId, options } = await generatePasskeyAuthenticationOptions(actor, now);
    const response = buildAuthenticationResponse(authenticator, { rpID: "attacker.example", origin: "http://attacker.example",
      challenge: options.challenge, signCount: 1 });
    await expect(verifyPasskeyAuthenticationAndEnterLearnerMode({ ...actor, challengeId, response }, now))
      .rejects.toEqual(new WebAuthnError("WEBAUTHN_AUTHENTICATION_INVALID"));
  });

  it("lets a reauthenticated parent revoke a credential, tearing down any active learner-mode context using it", async () => {
    const { user, learner } = await fixture();
    const { authenticator, actor, credential } = await registerPasskey(user, learner);
    const { challengeId, options } = await generatePasskeyAuthenticationOptions(actor, now);
    await verifyPasskeyAuthenticationAndEnterLearnerMode({ ...actor, challengeId,
      response: buildAuthenticationResponse(authenticator, { rpID, origin, challenge: options.challenge, signCount: 1 }) }, now);
    expect(deriveAuthorizationContext({ parentUserId: user.id, parentSessionId: "parent-session-1",
      deviceSessionId: "device-1", now }).mode).toBe("learner_mode");

    revokeLearnerPasskey({ parentUserId: user.id, learnerId: learner.id, credentialRowId: credential.id,
      parentPasswordReauthenticated: true, now });

    expect(listLearnerPasskeys(user.id, learner.id)[0]).toMatchObject({ status: "revoked" });
    // Matches AU-002's own fail-closed behavior: a revoked unlock context
    // is a hard authorization error on next use, not a silent fallback to
    // parent_management (tests/authorization-modes.test.ts covers the
    // general case; this confirms IA-004's revoke path wires into it).
    expect(() => deriveAuthorizationContext({ parentUserId: user.id, parentSessionId: "parent-session-1",
      deviceSessionId: "device-1", now })).toThrowError(new AuthorizationModeError("LEARNER_UNLOCK_CONTEXT_INVALID"));
  });

  it("refuses to revoke without reauthentication", () => {
    expect(() => revokeLearnerPasskey({ parentUserId: "p", learnerId: "l", credentialRowId: "c",
      parentPasswordReauthenticated: false, now })).toThrowError(new WebAuthnError("PARENT_REAUTHENTICATION_REQUIRED"));
  });
});
