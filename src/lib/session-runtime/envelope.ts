import { SignJWT, jwtVerify, importPKCS8, importSPKI, errors as joseErrors, type KeyLike } from "jose";

const ISSUER = "https://babysteps.in";
const AUDIENCE = "babysteps:session-envelope";
export const SESSION_ENVELOPE_VERSION = 1;

export class SessionEnvelopeError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "SessionEnvelopeError"; }
}

export type SessionEnvelopeClaims = {
  learner_session_id: string; learner_id: string; app_id: string; environment: string;
  deployment_id: string; release_id: string; device_session_id: string;
  usable_launch_established_at: string; hard_expires_at: string; maximum_connected_seconds: number;
  envelope_version: number;
};

type EnvelopeInput = Omit<SessionEnvelopeClaims, "envelope_version">;

function pem(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is required`);
  return value.replaceAll("\\n", "\n");
}

// SC-001 (GAP-078): the envelope is verified by the browser runtime SDK
// itself before it trusts a local session into existence, so it must be
// verifiable with a value that is safe to ship to the browser — an Ed25519
// public key, never the private signing key.
export async function issueSessionEnvelope(
  claims: EnvelopeInput, now: Date, privateKeyPem = process.env.SESSION_ENVELOPE_SIGNING_PRIVATE_KEY,
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const hardExpiry = Math.floor(new Date(claims.hard_expires_at).getTime() / 1000);
  const privateKey = (await importPKCS8(pem(privateKeyPem, "SESSION_ENVELOPE_SIGNING_PRIVATE_KEY"), "EdDSA")) as KeyLike;
  return new SignJWT({ ...claims, envelope_version: SESSION_ENVELOPE_VERSION })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT" })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(claims.learner_session_id)
    .setIssuedAt(issuedAt).setExpirationTime(hardExpiry)
    .sign(privateKey);
}

export async function verifySessionEnvelope(
  token: string,
  expected: { appId: string; deploymentId: string; releaseId: string },
  now: Date,
  publicKeyPem = process.env.SESSION_ENVELOPE_SIGNING_PUBLIC_KEY,
): Promise<SessionEnvelopeClaims> {
  let payload;
  try {
    const publicKey = (await importSPKI(pem(publicKeyPem, "SESSION_ENVELOPE_SIGNING_PUBLIC_KEY"), "EdDSA")) as KeyLike;
    payload = (await jwtVerify(token, publicKey, {
      issuer: ISSUER, audience: AUDIENCE, algorithms: ["EdDSA"], currentDate: now,
    })).payload;
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) throw new SessionEnvelopeError("SESSION_HARD_EXPIRED");
    throw new SessionEnvelopeError("SESSION_ENVELOPE_INVALID");
  }
  const claims = payload as unknown as SessionEnvelopeClaims;
  if (claims.envelope_version !== SESSION_ENVELOPE_VERSION) {
    throw new SessionEnvelopeError("SESSION_RUNTIME_VERSION_UNSUPPORTED");
  }
  if (claims.app_id !== expected.appId || claims.deployment_id !== expected.deploymentId ||
      claims.release_id !== expected.releaseId) {
    throw new SessionEnvelopeError("SESSION_ENVELOPE_INVALID");
  }
  return claims;
}
