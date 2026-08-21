import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse,
  verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { resolveDbClient } from "@/lib/db-client";
import type { EndUserAuthorizationContext } from "@/lib/authorization/modes";

const CHALLENGE_LIFETIME_MS = 5 * 60_000;
const RECEIPT_LIFETIME_MS = 60_000;
type Purpose = "registration" | "authentication";
type Actor = { parentUserId: string; parentSessionId: string; deviceSessionId: string; learnerId: string };
type Credential = { id: string; credential_id: string; public_key: string; sign_count: number; transports_json: string;
  device_type: string; backed_up: boolean; label: string; status: string; created_at: string; last_used_at: string | null };
type Transport = "ble" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";

export class WebAuthnError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "WebAuthnError"; }
}

function config() {
  const rpID = process.env.WEBAUTHN_RP_ID;
  const rawOrigin = process.env.WEBAUTHN_ORIGIN;
  if (!rpID || !rawOrigin) throw new WebAuthnError("WEBAUTHN_NOT_CONFIGURED");
  let origin: URL;
  try { origin = new URL(rawOrigin); } catch { throw new WebAuthnError("WEBAUTHN_NOT_CONFIGURED"); }
  if (origin.protocol !== "https:" || origin.origin !== rawOrigin || origin.hostname !== rpID) {
    throw new WebAuthnError("WEBAUTHN_NOT_CONFIGURED");
  }
  return { rpID, origin: rawOrigin, rpName: process.env.WEBAUTHN_RP_NAME ?? "BabySteps" };
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const matcher = (hash: string) => (candidate: string) => sha256(candidate) === hash;

async function learner(actor: Actor) {
  const row = await resolveDbClient().get<{ display_name: string }>(
    "select display_name from learners where id=? and owner_parent_id=?", [actor.learnerId, actor.parentUserId]);
  if (!row) throw new WebAuthnError("RESOURCE_NOT_FOUND");
  return row;
}
async function credentials(learnerId: string) {
  return resolveDbClient().all<Credential>(
    "select * from learner_passkey_credentials where learner_id=? and status='active'", [learnerId]);
}
async function challenge(purpose: Purpose, actor: Actor, value: string, now: Date) {
  const id = randomUUID();
  await resolveDbClient().run(`insert into webauthn_challenges
    (id,purpose,parent_user_id,parent_session_id,device_session_id,learner_id,challenge_hash,expires_at)
    values(?,?,?,?,?,?,?,?)`, [id, purpose, actor.parentUserId, actor.parentSessionId, actor.deviceSessionId,
    actor.learnerId, sha256(value), new Date(now.getTime() + CHALLENGE_LIFETIME_MS).toISOString()]);
  return id;
}
async function consume(challengeId: string, purpose: Purpose, actor: Actor, now: Date) {
  const row = await resolveDbClient().get<{ challenge_hash: string }>(`update webauthn_challenges set consumed_at=?
    where id=? and purpose=? and parent_user_id=? and parent_session_id=? and device_session_id=? and learner_id=?
      and consumed_at is null and expires_at>?
    returning challenge_hash`, [now.toISOString(), challengeId, purpose, actor.parentUserId, actor.parentSessionId,
    actor.deviceSessionId, actor.learnerId, now.toISOString()]);
  if (!row) throw new WebAuthnError("WEBAUTHN_CHALLENGE_INVALID");
  return row;
}

export async function generatePasskeyRegistrationOptions(actor: Actor, now = new Date()) {
  const owner = await learner(actor), { rpID, rpName } = config(), active = await credentials(actor.learnerId);
  const options = await generateRegistrationOptions({ rpName, rpID, userName: owner.display_name,
    userID: randomBytes(32), userDisplayName: owner.display_name, attestationType: "none",
    excludeCredentials: active.map(row => ({ id: row.credential_id, transports: JSON.parse(row.transports_json) as Transport[] })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" } });
  return { challengeId: await challenge("registration", actor, options.challenge, now), options };
}

export async function verifyPasskeyRegistration(actor: Actor & { challengeId: string; response: RegistrationResponseJSON; label: string }, now = new Date()) {
  await learner(actor); const stored = await consume(actor.challengeId, "registration", actor, now); const { rpID, origin } = config();
  let result;
  try { result = await verifyRegistrationResponse({ response: actor.response, expectedChallenge: matcher(stored.challenge_hash), expectedOrigin: origin, expectedRPID: rpID }); }
  catch { throw new WebAuthnError("WEBAUTHN_REGISTRATION_INVALID"); }
  if (!result.verified) throw new WebAuthnError("WEBAUTHN_REGISTRATION_INVALID");
  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo; const id = randomUUID();
  await resolveDbClient().run(`insert into learner_passkey_credentials
    (id,learner_id,owner_parent_id,credential_id,public_key,sign_count,transports_json,device_type,backed_up,label,status,created_at)
    values(?,?,?,?,?,?,?,?,?,?,'active',?)`, [id, actor.learnerId, actor.parentUserId, credential.id,
    Buffer.from(credential.publicKey).toString("base64"), credential.counter, JSON.stringify(credential.transports ?? []),
    credentialDeviceType, credentialBackedUp, actor.label, now.toISOString()]);
  return { id, credentialId: credential.id, label: actor.label };
}

export async function generatePasskeyAuthenticationOptions(actor: Actor, now = new Date()) {
  await learner(actor); const active = await credentials(actor.learnerId); if (!active.length) throw new WebAuthnError("NO_PASSKEY_REGISTERED");
  const { rpID } = config(); const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred",
    allowCredentials: active.map(row => ({ id: row.credential_id, transports: JSON.parse(row.transports_json) as Transport[] })) });
  return { challengeId: await challenge("authentication", actor, options.challenge, now), options };
}

async function revokeCredential(id: string, credentialId: string, now: Date, reason: string) {
  const timestamp = now.toISOString();
  await resolveDbClient().transaction(async tx => {
    await tx.run("update learner_passkey_credentials set status='revoked',revoked_at=?,revocation_reason=? where id=?", [timestamp, reason, id]);
    await tx.run(`update learner_unlock_contexts set status='revoked',revoked_at=?,revocation_reason='credential_revoked',
      version=version+1,updated_at=? where credential_id=? and status='active'`, [timestamp, timestamp, credentialId]);
  });
}

export async function verifyPasskeyAuthenticationAndEnterLearnerMode(actor: Actor & { challengeId: string; response: AuthenticationResponseJSON }, now = new Date()): Promise<EndUserAuthorizationContext> {
  await learner(actor); const stored = await consume(actor.challengeId, "authentication", actor, now); const db = resolveDbClient();
  const credential = await db.get<Credential>("select * from learner_passkey_credentials where credential_id=? and learner_id=? and status='active'", [actor.response.id, actor.learnerId]);
  if (!credential) throw new WebAuthnError("WEBAUTHN_CREDENTIAL_NOT_FOUND"); const { rpID, origin } = config(); let result;
  try { result = await verifyAuthenticationResponse({ response: actor.response, expectedChallenge: matcher(stored.challenge_hash),
    expectedOrigin: origin, expectedRPID: rpID, credential: { id: credential.credential_id,
      publicKey: new Uint8Array(Buffer.from(credential.public_key, "base64")), counter: Number(credential.sign_count),
      transports: JSON.parse(credential.transports_json) } }); }
  catch (error) { if (error instanceof Error && /counter/i.test(error.message)) { await revokeCredential(credential.id, credential.credential_id, now, "clone_suspected"); throw new WebAuthnError("WEBAUTHN_CLONE_SUSPECTED"); }
    throw new WebAuthnError("WEBAUTHN_AUTHENTICATION_INVALID"); }
  if (!result.verified) throw new WebAuthnError("WEBAUTHN_AUTHENTICATION_INVALID");
  const expiresAt = new Date(now.getTime() + RECEIPT_LIFETIME_MS), timestamp = now.toISOString(), receiptId = randomUUID();
  return db.transaction(async tx => {
    const selected = await tx.get("select 1 from learner_selection_contexts where parent_session_id=? and parent_user_id=? and selected_learner_id=? and expires_at>?", [actor.parentSessionId, actor.parentUserId, actor.learnerId, timestamp]);
    if (!selected) throw new WebAuthnError("RESOURCE_NOT_FOUND");
    await tx.run("update learner_passkey_credentials set sign_count=?,last_used_at=? where id=? and status='active'", [result.authenticationInfo.newCounter, timestamp, credential.id]);
    await tx.run(`insert into learner_mode_unlock_receipts(id,parent_user_id,parent_session_id,device_session_id,learner_id,credential_id,verified_at,expires_at,consumed_at)
      values(?,?,?,?,?,?,?,?,?)`, [receiptId, actor.parentUserId, actor.parentSessionId, actor.deviceSessionId, actor.learnerId, credential.credential_id, timestamp, expiresAt.toISOString(), timestamp]);
    const context = await tx.get<{ version: number }>(`insert into learner_unlock_contexts(parent_session_id,device_session_id,parent_user_id,learner_id,credential_id,status,expires_at,version,created_at,updated_at)
      values(?,?,?,?,?,'active',?,1,?,?) on conflict(parent_session_id,device_session_id) do update set learner_id=excluded.learner_id,
      credential_id=excluded.credential_id,status='active',expires_at=excluded.expires_at,version=learner_unlock_contexts.version+1,
      updated_at=excluded.updated_at,revoked_at=null,revocation_reason=null returning version`, [actor.parentSessionId, actor.deviceSessionId,
      actor.parentUserId, actor.learnerId, credential.credential_id, expiresAt.toISOString(), timestamp, timestamp]);
    await tx.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,'learner_mode_activated',?)", [randomUUID(), actor.parentUserId, JSON.stringify({ learnerId: actor.learnerId, deviceSessionId: actor.deviceSessionId, credentialId: credential.credential_id })]);
    return { parentUserId: actor.parentUserId, parentSessionId: actor.parentSessionId, deviceSessionId: actor.deviceSessionId,
      mode: "learner_mode", learnerId: actor.learnerId, credentialId: credential.credential_id,
      contextVersion: Number(context?.version ?? 1), modeGeneration: Number(context?.version ?? 1) };
  });
}

export async function listLearnerPasskeys(parentUserId: string, learnerId: string) {
  await learner({ parentUserId, learnerId, parentSessionId: "", deviceSessionId: "" });
  const rows = await resolveDbClient().all<Credential>(`select id,credential_id,label,status,device_type,backed_up,created_at,last_used_at
    from learner_passkey_credentials where learner_id=? order by created_at desc`, [learnerId]);
  return rows.map(row => ({ id: row.id, label: row.label, status: row.status, deviceType: row.device_type,
    backedUp: !!row.backed_up, createdAt: row.created_at, lastUsedAt: row.last_used_at }));
}

export async function revokeLearnerPasskey(input: { parentUserId: string; learnerId: string; credentialRowId: string; parentPasswordReauthenticated: boolean; now: Date }) {
  if (!input.parentPasswordReauthenticated) throw new WebAuthnError("PARENT_REAUTHENTICATION_REQUIRED");
  const row = await resolveDbClient().get<{ credential_id: string }>(`select credential_id from learner_passkey_credentials
    where id=? and learner_id=? and owner_parent_id=? and status='active'`, [input.credentialRowId, input.learnerId, input.parentUserId]);
  if (!row) throw new WebAuthnError("RESOURCE_NOT_FOUND"); await revokeCredential(input.credentialRowId, row.credential_id, input.now, "parent_revoked");
  return { revoked: true as const };
}
