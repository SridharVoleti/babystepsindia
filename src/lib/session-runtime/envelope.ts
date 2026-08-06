import { createSecretKey } from "node:crypto";
import { SignJWT, jwtVerify, errors as joseErrors } from "jose";

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

function key(secret: string | undefined) {
  if (!secret || secret.length < 32) throw new Error("SESSION_ENVELOPE_SECRET must be at least 32 characters");
  return createSecretKey(Buffer.from(secret));
}

export async function issueSessionEnvelope(
  claims: EnvelopeInput, now: Date, secret = process.env.SESSION_ENVELOPE_SECRET,
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const hardExpiry = Math.floor(new Date(claims.hard_expires_at).getTime() / 1000);
  return new SignJWT({ ...claims, envelope_version: SESSION_ENVELOPE_VERSION })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(claims.learner_session_id)
    .setIssuedAt(issuedAt).setExpirationTime(hardExpiry)
    .sign(key(secret));
}

export async function verifySessionEnvelope(
  token: string,
  expected: { appId: string; deploymentId: string; releaseId: string },
  now: Date,
  secret = process.env.SESSION_ENVELOPE_SECRET,
): Promise<SessionEnvelopeClaims> {
  let payload;
  try {
    payload = (await jwtVerify(token, key(secret), {
      issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"], currentDate: now,
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
