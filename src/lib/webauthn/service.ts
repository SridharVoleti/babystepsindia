import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { getDb } from "@/lib/db/client";
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

function assertLearnerOwned(actor: CeremonyActor) {
  const owned = getDb().prepare("select display_name from learners where id=? and owner_parent_id=?")
    .get(actor.learnerId, actor.parentUserId) as { display_name: string } | undefined;
  if (!owned) throw new WebAuthnError("RESOURCE_NOT_FOUND");
  return owned;
}

function activeCredentials(learnerId: string) {
  return getDb().prepare("select * from learner_passkey_credentials where learner_id=? and status='active'")
    .all(learnerId) as CredentialRow[];
}

function storeChallenge(purpose: "registration" | "authentication", actor: CeremonyActor, challenge: string, now: Date) {
  const id = randomUUID();
  getDb().prepare(`insert into webauthn_challenges
    (id,purpose,parent_user_id,parent_session_id,device_session_id,learner_id,challenge_hash,expires_at)
    values(?,?,?,?,?,?,?,?)`).run(id, purpose, actor.parentUserId, actor.parentSessionId, actor.deviceSessionId,
    actor.learnerId, sha256(challenge), new Date(now.getTime() + CHALLENGE_LIFETIME_MS).toISOString());
  return id;
}

function consumeChallenge(challengeId: string, purpose: "registration" | "authentication", actor: CeremonyActor, now: Date) {
  const db = getDb();
  const row = db.prepare(`select * from webauthn_challenges where id=? and purpose=? and parent_user_id=?
    and parent_session_id=? and device_session_id=? and learner_id=? and consumed_at is null and expires_at>?`)
    .get(challengeId, purpose, actor.parentUserId, actor.parentSessionId, actor.deviceSessionId, actor.learnerId,
      now.toISOString()) as ChallengeRow | undefined;
  if (!row) throw new WebAuthnError("WEBAUTHN_CHALLENGE_INVALID");
  const consumed = db.prepare("update webauthn_challenges set consumed_at=? where id=? and consumed_at is null")
    .run(now.toISOString(), challengeId).changes;
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
  const learner = assertLearnerOwned(actor);
  const { rpID, rpName } = rpConfig();
  const excludeCredentials = activeCredentials(actor.learnerId).map((row) => ({
    id: row.credential_id, transports: JSON.parse(row.transports_json) as AuthenticatorTransportFuture[],
  }));
  const options = await generateRegistrationOptions({
    rpName, rpID, userName: learner.display_name, userID: randomBytes(32),
    userDisplayName: learner.display_name, attestationType: "none", excludeCredentials,
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  const challengeId = storeChallenge("registration", actor, options.challenge, now);
  return { challengeId, options };
}

export async function verifyPasskeyRegistration(actor: CeremonyActor & {
  challengeId: string; response: RegistrationResponseJSON; label: string;
}, now = new Date()) {
  assertLearnerOwned(actor);
  const challenge = consumeChallenge(actor.challengeId, "registration", actor, now);
  const { rpID, origin } = rpConfig();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: actor.response, expectedChallenge: expectedChallengeMatcher(challenge.challenge_hash),
      expectedOrigin: origin, expectedRPID: rpID,
    });
  } catch { throw new WebAuthnError("WEBAUTHN_REGISTRATION_INVALID"); }
  if (!verification.verified) throw new WebAuthnError("WEBAUTHN_REGISTRATION_INVALID");
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const id = randomUUID();
  getDb().prepare(`insert into learner_passkey_credentials
    (id,learner_id,owner_parent_id,credential_id,public_key,sign_count,transports_json,device_type,backed_up,
     label,status,created_at)
    values(?,?,?,?,?,?,?,?,?,?,'active',?)`).run(id, actor.learnerId, actor.parentUserId, credential.id,
    Buffer.from(credential.publicKey).toString("base64"), credential.counter,
    JSON.stringify(credential.transports ?? []), credentialDeviceType, credentialBackedUp ? 1 : 0,
    actor.label, now.toISOString());
  return { id, credentialId: credential.id, label: actor.label };
}

export async function generatePasskeyAuthenticationOptions(actor: CeremonyActor, now = new Date()) {
  assertLearnerOwned(actor);
  const credentials = activeCredentials(actor.learnerId);
  if (credentials.length === 0) throw new WebAuthnError("NO_PASSKEY_REGISTERED");
  const { rpID } = rpConfig();
  const options = await generateAuthenticationOptions({
    rpID, userVerification: "preferred",
    allowCredentials: credentials.map((row) => ({
      id: row.credential_id, transports: JSON.parse(row.transports_json) as AuthenticatorTransportFuture[],
    })),
  });
  const challengeId = storeChallenge("authentication", actor, options.challenge, now);
  return { challengeId, options };
}

export async function verifyPasskeyAuthenticationAndEnterLearnerMode(actor: CeremonyActor & {
  challengeId: string; response: AuthenticationResponseJSON;
}, now = new Date()): Promise<EndUserAuthorizationContext> {
  assertLearnerOwned(actor);
  const challenge = consumeChallenge(actor.challengeId, "authentication", actor, now);
  const db = getDb();
  const credential = db.prepare(`select * from learner_passkey_credentials
    where credential_id=? and learner_id=? and status='active'`).get(actor.response.id, actor.learnerId) as CredentialRow | undefined;
  if (!credential) throw new WebAuthnError("WEBAUTHN_CREDENTIAL_NOT_FOUND");
  const { rpID, origin } = rpConfig();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: actor.response, expectedChallenge: expectedChallengeMatcher(challenge.challenge_hash),
      expectedOrigin: origin, expectedRPID: rpID,
      credential: { id: credential.credential_id, publicKey: new Uint8Array(Buffer.from(credential.public_key, "base64")),
        counter: credential.sign_count, transports: JSON.parse(credential.transports_json) },
    });
  } catch (error) {
    // The library itself performs standard WebAuthn clone-detection (a
    // signature counter that fails to advance past its last known value)
    // and throws a plain Error rather than returning verified:false — this
    // is the one failure mode that must revoke the credential, not just
    // reject the attempt.
    if (error instanceof Error && /counter/i.test(error.message)) {
      db.prepare(`update learner_passkey_credentials set status='revoked',revoked_at=?,revocation_reason='clone_suspected'
        where id=?`).run(now.toISOString(), credential.id);
      throw new WebAuthnError("WEBAUTHN_CLONE_SUSPECTED");
    }
    throw new WebAuthnError("WEBAUTHN_AUTHENTICATION_INVALID");
  }
  if (!verification.verified) throw new WebAuthnError("WEBAUTHN_AUTHENTICATION_INVALID");
  const { newCounter } = verification.authenticationInfo;
  return db.transaction(() => {
    db.prepare("update learner_passkey_credentials set sign_count=?,last_used_at=? where id=?")
      .run(newCounter, now.toISOString(), credential.id);
    const receiptExpiresAt = new Date(now.getTime() + RECEIPT_LIFETIME_MS);
    const receipt = recordTrustedPasskeyVerification({
      parentUserId: actor.parentUserId, parentSessionId: actor.parentSessionId, deviceSessionId: actor.deviceSessionId,
      learnerId: actor.learnerId, credentialId: credential.credential_id, verifiedAt: now, expiresAt: receiptExpiresAt,
    });
    return activateLearnerMode({
      parentUserId: actor.parentUserId, parentSessionId: actor.parentSessionId, deviceSessionId: actor.deviceSessionId,
      learnerId: actor.learnerId, verificationReceiptId: receipt.id, expiresAt: receiptExpiresAt, now,
    });
  })();
}

export function listLearnerPasskeys(parentUserId: string, learnerId: string) {
  const owned = getDb().prepare("select 1 from learners where id=? and owner_parent_id=?").get(learnerId, parentUserId);
  if (!owned) throw new WebAuthnError("RESOURCE_NOT_FOUND");
  const rows = getDb().prepare(`select id,credential_id,label,status,device_type,backed_up,created_at,last_used_at
    from learner_passkey_credentials where learner_id=? order by created_at desc`).all(learnerId) as
    Array<{ id: string; credential_id: string; label: string; status: string; device_type: string; backed_up: number;
      created_at: string; last_used_at: string | null }>;
  return rows.map((row) => ({ id: row.id, label: row.label, status: row.status, deviceType: row.device_type,
    backedUp: !!row.backed_up, createdAt: row.created_at, lastUsedAt: row.last_used_at }));
}

export function revokeLearnerPasskey(input: { parentUserId: string; learnerId: string; credentialRowId: string;
  parentPasswordReauthenticated: boolean; now: Date }) {
  if (!input.parentPasswordReauthenticated) throw new WebAuthnError("PARENT_REAUTHENTICATION_REQUIRED");
  const db = getDb();
  const row = db.prepare(`select credential_id from learner_passkey_credentials
    where id=? and learner_id=? and owner_parent_id=? and status='active'`)
    .get(input.credentialRowId, input.learnerId, input.parentUserId) as { credential_id: string } | undefined;
  if (!row) throw new WebAuthnError("RESOURCE_NOT_FOUND");
  const timestamp = input.now.toISOString();
  return db.transaction(() => {
    db.prepare(`update learner_passkey_credentials set status='revoked',revoked_at=?,revocation_reason='parent_revoked'
      where id=?`).run(timestamp, input.credentialRowId);
    revokeLearnerContextsByCredential(row.credential_id, input.now);
    return { revoked: true as const };
  })();
}

type AuthenticatorTransportFuture = "ble" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";
