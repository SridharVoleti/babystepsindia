import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { activateLearnerMode, revokeLearnerContextsByCredential, type EndUserAuthorizationContext } from "@/lib/authorization/modes";
import { recordTrustedPasskeyVerification } from "@/lib/authorization/passkey-verification";

const CHALLENGE_LIFETIME_MS = 5 * 60_000;
const RECEIPT_LIFETIME_MS = 60_000;

export class WebAuthnError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "WebAuthnError"; }
}

type CeremonyActor = { parentUserId: string; parentSessionId: string; deviceSessionId: string; learnerId: string };

type ChallengeRow = {
  id: string; purpose: "registration" | "authentication"; parent_user_id: string; parent_session_id: string;
  device_session_id: string; learner_id: string; challenge_hash: string; expires_at: string; consumed_at: string | null;
};

type CredentialRow = {
  id: string; learner_id: string; owner_parent_id: string; credential_id: string; public_key: string;
  sign_count: number; transports_json: string; device_type: string; backed_up: number; label: string;
  status: string; created_at: string; last_used_at: string | null;
};

function rpConfig() {
  const rpID = process.env.WEBAUTHN_RP_ID;
  const rpName = process.env.WEBAUTHN_RP_NAME ?? "BabySteps";
  const origin = process.env.WEBAUTHN_ORIGIN;
  if (!rpID || !origin) throw new WebAuthnError("WEBAUTHN_NOT_CONFIGURED");
  return { rpID, rpName, origin };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function assertLearnerOwned(actor: CeremonyActor) {
  const owned = await resolveDbClient().get<{ display_name: string }>(
    "select display_name from learners where id=? and owner_parent_id=?", [actor.learnerId, actor.parentUserId]);
  if (!owned) throw new WebAuthnError("RESOURCE_NOT_FOUND");
  return owned;
}

async function activeCredentials(learnerId: string) {
  return resolveDbClient().all<CredentialRow>(
    "select * from learner_passkey_credentials where learner_id=? and status='active'", [learnerId]);
}

async function storeChallenge(purpose: "registration" | "authentication", actor: CeremonyActor, challenge: string, now: Date) {
  const id = randomUUID();
  await resolveDbClient().run(`insert into webauthn_challenges
    (id,purpose,parent_user_id,parent_session_id,device_session_id,learner_id,challenge_hash,expires_at)
    values(?,?,?,?,?,?,?,?)`, [id, purpose, actor.parentUserId, actor.parentSessionId, actor.deviceSessionId,
    actor.learnerId, sha256(challenge), new Date(now.getTime() + CHALLENGE_LIFETIME_MS).toISOString()]);
  return id;
}

async function consumeChallenge(challengeId: string, purpose: "registration" | "authentication", actor: CeremonyActor, now: Date) {
  const db = resolveDbClient();
  const row = await db.get<ChallengeRow>(`select * from webauthn_challenges where id=? and purpose=? and parent_user_id=?
    and parent_session_id=? and device_session_id=? and learner_id=? and consumed_at is null and expires_at>?`,
    [challengeId, purpose, actor.parentUserId, actor.parentSessionId, actor.deviceSessionId, actor.learnerId,
      now.toISOString()]);
  if (!row) throw new WebAuthnError("WEBAUTHN_CHALLENGE_INVALID");
  const consumed = (await db.run("update webauthn_challenges set consumed_at=? where id=? and consumed_at is null",
    [now.toISOString(), challengeId])).changes;
  if (consumed !== 1) throw new WebAuthnError("WEBAUTHN_CHALLENGE_INVALID");
  return row;
}

// GAP-072: the raw challenge is never persisted — only its hash — so
// verification below compares by re-hashing the value the browser echoed
// back rather than looking one up.
function expectedChallengeMatcher(challengeHash: string) {
  return (candidate: string) => sha256(candidate) === challengeHash;
}

export async function generatePasskeyRegistrationOptions(actor: CeremonyActor, now = new Date()) {
  const learner = await assertLearnerOwned(actor);
  const { rpID, rpName } = rpConfig();
  const excludeCredentials = (await activeCredentials(actor.learnerId)).map((row) => ({
    id: row.credential_id, transports: JSON.parse(row.transports_json) as AuthenticatorTransportFuture[],
  }));
  const options = await generateRegistrationOptions({
    rpName, rpID, userName: learner.display_name, userID: randomBytes(32),
    userDisplayName: learner.display_name, attestationType: "none", excludeCredentials,
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  const challengeId = await storeChallenge("registration", actor, options.challenge, now);
  return { challengeId, options };
}

export async function verifyPasskeyRegistration(actor: CeremonyActor & {
  challengeId: string; response: RegistrationResponseJSON; label: string;
}, now = new Date()) {
  await assertLearnerOwned(actor);
  const challenge = await consumeChallenge(actor.challengeId, "registration", actor, now);
  const { rpID, origin } = rpConfig();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: actor.response, expectedChallenge: expectedChallengeMatcher(challenge.challenge_hash),
      expectedOrigin: origin, expectedRPID: rpID,
      // generatePasskeyRegistrationOptions asks for userVerification:"preferred"
      // (so authenticators without UV, e.g. bare security keys, can still
      // register) — @simplewebauthn/server defaults this to true regardless,
      // which would silently re-impose "required" here and contradict that.
      requireUserVerification: false,
    });
  } catch { throw new WebAuthnError("WEBAUTHN_REGISTRATION_INVALID"); }
  if (!verification.verified) throw new WebAuthnError("WEBAUTHN_REGISTRATION_INVALID");
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const id = randomUUID();
  await resolveDbClient().run(`insert into learner_passkey_credentials
    (id,learner_id,owner_parent_id,credential_id,public_key,sign_count,transports_json,device_type,backed_up,
     label,status,created_at)
    values(?,?,?,?,?,?,?,?,?,?,'active',?)`, [id, actor.learnerId, actor.parentUserId, credential.id,
    Buffer.from(credential.publicKey).toString("base64"), credential.counter,
    JSON.stringify(credential.transports ?? []), credentialDeviceType, credentialBackedUp ? 1 : 0,
    actor.label, now.toISOString()]);
  return { id, credentialId: credential.id, label: actor.label };
}

export async function generatePasskeyAuthenticationOptions(actor: CeremonyActor, now = new Date()) {
  await assertLearnerOwned(actor);
  const credentials = await activeCredentials(actor.learnerId);
  if (credentials.length === 0) throw new WebAuthnError("NO_PASSKEY_REGISTERED");
  const { rpID } = rpConfig();
  const options = await generateAuthenticationOptions({
    rpID, userVerification: "preferred",
    allowCredentials: credentials.map((row) => ({
      id: row.credential_id, transports: JSON.parse(row.transports_json) as AuthenticatorTransportFuture[],
    })),
  });
  const challengeId = await storeChallenge("authentication", actor, options.challenge, now);
  return { challengeId, options };
}

export async function verifyPasskeyAuthenticationAndEnterLearnerMode(actor: CeremonyActor & {
  challengeId: string; response: AuthenticationResponseJSON; contextExpiresAt: Date;
}, now = new Date()): Promise<EndUserAuthorizationContext> {
  await assertLearnerOwned(actor);
  const challenge = await consumeChallenge(actor.challengeId, "authentication", actor, now);
  const credential = await resolveDbClient().get<CredentialRow>(`select * from learner_passkey_credentials
    where credential_id=? and learner_id=? and status='active'`, [actor.response.id, actor.learnerId]);
  if (!credential) throw new WebAuthnError("WEBAUTHN_CREDENTIAL_NOT_FOUND");
  const { rpID, origin } = rpConfig();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: actor.response, expectedChallenge: expectedChallengeMatcher(challenge.challenge_hash),
      expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: credential.credential_id, publicKey: new Uint8Array(Buffer.from(credential.public_key, "base64")),
        counter: credential.sign_count, transports: JSON.parse(credential.transports_json) },
      // generatePasskeyAuthenticationOptions asks for userVerification:"preferred",
      // but @simplewebauthn/server's own default here is to still require the
      // UV flag regardless — that mismatch made every real authentication
      // fail whenever the platform satisfied "preferred" with presence only
      // (no biometric/PIN), even though the ceremony itself was legitimate.
      requireUserVerification: false,
    });
  } catch (error) {
    // The library itself performs standard WebAuthn clone-detection (a
    // signature counter that fails to advance past its last known value)
    // and throws a plain Error rather than returning verified:false — this
    // is the one failure mode that must revoke the credential, not just
    // reject the attempt.
    if (error instanceof Error && /counter/i.test(error.message)) {
      await resolveDbClient().run(`update learner_passkey_credentials set status='revoked',revoked_at=?,revocation_reason='clone_suspected'
        where id=?`, [now.toISOString(), credential.id]);
      throw new WebAuthnError("WEBAUTHN_CLONE_SUSPECTED");
    }
    throw new WebAuthnError("WEBAUTHN_AUTHENTICATION_INVALID");
  }
  if (!verification.verified) throw new WebAuthnError("WEBAUTHN_AUTHENTICATION_INVALID");
  const { newCounter } = verification.authenticationInfo;
  return resolveDbClient().transaction(async (db: DbClient) => {
    await db.run("update learner_passkey_credentials set sign_count=?,last_used_at=? where id=?",
      [newCounter, now.toISOString(), credential.id]);
    // The receipt's own expiry is a short anti-replay window for consuming
    // this one-time passkey verification (RECEIPT_LIFETIME_MS) — it must
    // NOT be reused as how long the resulting learner_mode session lasts.
    // That's actor.contextExpiresAt (the parent's own browser session
    // expiry), matching how long learner_selection_contexts already lives.
    // Conflating the two previously expired every learner_mode session ~60
    // seconds after unlock, bouncing the very next page load back to /login.
    const receiptExpiresAt = new Date(now.getTime() + RECEIPT_LIFETIME_MS);
    const receipt = await recordTrustedPasskeyVerification({
      parentUserId: actor.parentUserId, parentSessionId: actor.parentSessionId, deviceSessionId: actor.deviceSessionId,
      learnerId: actor.learnerId, credentialId: credential.credential_id, verifiedAt: now, expiresAt: receiptExpiresAt,
    });
    return activateLearnerMode({
      parentUserId: actor.parentUserId, parentSessionId: actor.parentSessionId, deviceSessionId: actor.deviceSessionId,
      learnerId: actor.learnerId, verificationReceiptId: receipt.id, expiresAt: actor.contextExpiresAt, now,
    });
  });
}

export async function listLearnerPasskeys(parentUserId: string, learnerId: string) {
  const owned = await resolveDbClient().get("select 1 from learners where id=? and owner_parent_id=?", [learnerId, parentUserId]);
  if (!owned) throw new WebAuthnError("RESOURCE_NOT_FOUND");
  const rows = await resolveDbClient().all<
    { id: string; credential_id: string; label: string; status: string; device_type: string; backed_up: number;
      created_at: string; last_used_at: string | null }
  >(`select id,credential_id,label,status,device_type,backed_up,created_at,last_used_at
    from learner_passkey_credentials where learner_id=? order by created_at desc`, [learnerId]);
  return rows.map((row) => ({ id: row.id, label: row.label, status: row.status, deviceType: row.device_type,
    backedUp: !!row.backed_up, createdAt: row.created_at, lastUsedAt: row.last_used_at }));
}

export async function revokeLearnerPasskey(input: { parentUserId: string; learnerId: string; credentialRowId: string;
  parentPasswordReauthenticated: boolean; now: Date }) {
  if (!input.parentPasswordReauthenticated) throw new WebAuthnError("PARENT_REAUTHENTICATION_REQUIRED");
  const row = await resolveDbClient().get<{ credential_id: string }>(`select credential_id from learner_passkey_credentials
    where id=? and learner_id=? and owner_parent_id=? and status='active'`,
    [input.credentialRowId, input.learnerId, input.parentUserId]);
  if (!row) throw new WebAuthnError("RESOURCE_NOT_FOUND");
  const timestamp = input.now.toISOString();
  return resolveDbClient().transaction(async (db: DbClient) => {
    await db.run(`update learner_passkey_credentials set status='revoked',revoked_at=?,revocation_reason='parent_revoked'
      where id=?`, [timestamp, input.credentialRowId]);
    await revokeLearnerContextsByCredential(row.credential_id, input.now);
    return { revoked: true as const };
  });
}

type AuthenticatorTransportFuture = "ble" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";
