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
import { STAFF_CHALLENGE_TTL_MS } from "@/lib/staff-identity/contracts";

// AD-001 mirror of src/lib/webauthn/service.ts (IA-004), scoped to staff
// instead of learners — same RP config, hash-not-store challenge pattern
// (GAP-072) and sign-count clone-detection, against the staff_passkey_
// credentials/staff_auth_challenges tables instead.

export class StaffWebAuthnError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "StaffWebAuthnError";
  }
}

type Purpose = "login" | "register" | "reauth";

type ChallengeRow = {
  id: string;
  purpose: Purpose;
  staff_account_id: string;
  challenge_hash: string;
  expires_at: string;
  consumed_at: string | null;
};

type CredentialRow = {
  id: string;
  staff_account_id: string;
  credential_id: string;
  public_key: string;
  sign_count: number;
  transports_json: string;
  device_type: string;
  backed_up: number;
  label: string;
  status: string;
  created_at: string;
  last_used_at: string | null;
};

type AuthenticatorTransportFuture = "ble" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";

function rpConfig() {
  const rpID = process.env.WEBAUTHN_RP_ID;
  const rpName = process.env.WEBAUTHN_RP_NAME ?? "BabySteps";
  const origin = process.env.WEBAUTHN_ORIGIN;
  if (!rpID || !origin) throw new StaffWebAuthnError("WEBAUTHN_NOT_CONFIGURED");
  return { rpID, rpName, origin };
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function activeCredentials(staffAccountId: string) {
  return resolveDbClient().all<CredentialRow>(
    "select * from staff_passkey_credentials where staff_account_id=? and status='active'",
    [staffAccountId],
  );
}

async function storeChallenge(purpose: Purpose, staffAccountId: string, challenge: string, now: Date) {
  const id = randomUUID();
  await resolveDbClient().run(
    `insert into staff_auth_challenges (id,purpose,staff_account_id,challenge_hash,expires_at)
       values(?,?,?,?,?)`,
    [id, purpose, staffAccountId, sha256(challenge), new Date(now.getTime() + STAFF_CHALLENGE_TTL_MS).toISOString()],
  );
  return id;
}

async function consumeChallenge(challengeId: string, purpose: Purpose, staffAccountId: string, now: Date) {
  const db = resolveDbClient();
  const row = await db.get<ChallengeRow>(
    `select * from staff_auth_challenges where id=? and purpose=? and staff_account_id=?
       and consumed_at is null and expires_at>?`,
    [challengeId, purpose, staffAccountId, now.toISOString()],
  );
  if (!row) throw new StaffWebAuthnError("WEBAUTHN_CHALLENGE_INVALID");
  const consumed = (
    await db.run("update staff_auth_challenges set consumed_at=? where id=? and consumed_at is null", [
      now.toISOString(),
      challengeId,
    ])
  ).changes;
  if (consumed !== 1) throw new StaffWebAuthnError("WEBAUTHN_CHALLENGE_INVALID");
  return row;
}

function expectedChallengeMatcher(challengeHash: string) {
  return (candidate: string) => sha256(candidate) === challengeHash;
}

export async function generateStaffPasskeyRegistrationOptions(
  actor: { staffAccountId: string; displayName: string },
  now = new Date(),
) {
  const { rpID, rpName } = rpConfig();
  const excludeCredentials = (await activeCredentials(actor.staffAccountId)).map((row) => ({
    id: row.credential_id,
    transports: JSON.parse(row.transports_json) as AuthenticatorTransportFuture[],
  }));
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: actor.displayName,
    userID: randomBytes(32),
    userDisplayName: actor.displayName,
    attestationType: "none",
    excludeCredentials,
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  const challengeId = await storeChallenge("register", actor.staffAccountId, options.challenge, now);
  return { challengeId, options };
}

export async function verifyStaffPasskeyRegistration(
  actor: { staffAccountId: string; challengeId: string; response: RegistrationResponseJSON; label: string },
  now = new Date(),
) {
  const challenge = await consumeChallenge(actor.challengeId, "register", actor.staffAccountId, now);
  const { rpID, origin } = rpConfig();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: actor.response,
      expectedChallenge: expectedChallengeMatcher(challenge.challenge_hash),
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    throw new StaffWebAuthnError("WEBAUTHN_REGISTRATION_INVALID");
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw new StaffWebAuthnError("WEBAUTHN_REGISTRATION_INVALID");
  }
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const id = randomUUID();
  await resolveDbClient().run(
    `insert into staff_passkey_credentials
       (id,staff_account_id,credential_id,public_key,sign_count,transports_json,device_type,backed_up,label,status,created_at)
       values(?,?,?,?,?,?,?,?,?,'active',?)`,
    [
      id,
      actor.staffAccountId,
      credential.id,
      Buffer.from(credential.publicKey).toString("base64"),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      credentialDeviceType,
      credentialBackedUp ? 1 : 0,
      actor.label,
      now.toISOString(),
    ],
  );
  return { id, credentialId: credential.id, label: actor.label };
}

export async function generateStaffPasskeyAssertionOptions(
  actor: { staffAccountId: string; purpose: "login" | "reauth" },
  now = new Date(),
) {
  const credentials = await activeCredentials(actor.staffAccountId);
  if (credentials.length === 0) throw new StaffWebAuthnError("NO_PASSKEY_REGISTERED");
  const { rpID } = rpConfig();
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: credentials.map((row) => ({
      id: row.credential_id,
      transports: JSON.parse(row.transports_json) as AuthenticatorTransportFuture[],
    })),
  });
  const challengeId = await storeChallenge(actor.purpose, actor.staffAccountId, options.challenge, now);
  return { challengeId, options };
}

export async function verifyStaffPasskeyAssertion(
  actor: {
    staffAccountId: string;
    purpose: "login" | "reauth";
    challengeId: string;
    response: AuthenticationResponseJSON;
  },
  now = new Date(),
): Promise<{ credentialId: string }> {
  const challenge = await consumeChallenge(actor.challengeId, actor.purpose, actor.staffAccountId, now);
  const db = resolveDbClient();
  const credential = await db.get<CredentialRow>(
    `select * from staff_passkey_credentials where credential_id=? and staff_account_id=? and status='active'`,
    [actor.response.id, actor.staffAccountId],
  );
  if (!credential) throw new StaffWebAuthnError("WEBAUTHN_CREDENTIAL_NOT_FOUND");
  const { rpID, origin } = rpConfig();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: actor.response,
      expectedChallenge: expectedChallengeMatcher(challenge.challenge_hash),
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: credential.credential_id,
        publicKey: new Uint8Array(Buffer.from(credential.public_key, "base64")),
        counter: credential.sign_count,
        transports: JSON.parse(credential.transports_json),
      },
    });
  } catch (error) {
    // Same clone-detection treatment as IA-004's learner service: a
    // signature counter that fails to advance revokes the credential
    // rather than just rejecting the one attempt.
    if (error instanceof Error && /counter/i.test(error.message)) {
      await db.run(
        `update staff_passkey_credentials set status='revoked',revoked_at=?,revocation_reason='clone_suspected' where id=?`,
        [now.toISOString(), credential.id],
      );
      throw new StaffWebAuthnError("WEBAUTHN_CLONE_SUSPECTED");
    }
    throw new StaffWebAuthnError("WEBAUTHN_AUTHENTICATION_INVALID");
  }
  if (!verification.verified) throw new StaffWebAuthnError("WEBAUTHN_AUTHENTICATION_INVALID");
  const { newCounter } = verification.authenticationInfo;
  await db.run("update staff_passkey_credentials set sign_count=?,last_used_at=? where id=?", [
    newCounter,
    now.toISOString(),
    credential.id,
  ]);
  return { credentialId: credential.credential_id };
}

export async function listStaffPasskeys(staffAccountId: string) {
  const rows = await resolveDbClient().all<{
    id: string;
    credential_id: string;
    label: string;
    status: string;
    device_type: string;
    backed_up: number;
    created_at: string;
    last_used_at: string | null;
  }>(
    `select id,credential_id,label,status,device_type,backed_up,created_at,last_used_at
       from staff_passkey_credentials where staff_account_id=? order by created_at desc`,
    [staffAccountId],
  );
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    status: row.status,
    deviceType: row.device_type,
    backedUp: !!row.backed_up,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

export async function activeStaffPasskeyCount(staffAccountId: string): Promise<number> {
  return (await activeCredentials(staffAccountId)).length;
}

// Business rule 18: losing all passkeys never falls back to a self-
// service revoke — AD-005 (separate requirement) owns lost-passkey
// recovery. This only supports a staff member deliberately dropping one
// of several, requires the caller to have already verified sensitive
// reauth (business rule 15).
export async function revokeStaffPasskey(input: { staffAccountId: string; credentialRowId: string; now: Date }) {
  const db = resolveDbClient();
  const row = await db.get<{ credential_id: string }>(
    `select credential_id from staff_passkey_credentials where id=? and staff_account_id=? and status='active'`,
    [input.credentialRowId, input.staffAccountId],
  );
  if (!row) throw new StaffWebAuthnError("RESOURCE_NOT_FOUND");
  await db.run(
    `update staff_passkey_credentials set status='revoked',revoked_at=?,revocation_reason='staff_revoked' where id=?`,
    [input.now.toISOString(), input.credentialRowId],
  );
  return { revoked: true as const };
}
