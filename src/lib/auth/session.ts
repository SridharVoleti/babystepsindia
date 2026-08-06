import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import type { Entitlements } from "@/lib/db/types";

export const SESSION_COOKIE = "bs_session";

// Local dev only: a real Supabase-issued JWT is 1 hour (REQ-08 §4.2) with
// silent refresh on every request. There's no refresh flow here, so this
// is deliberately longer-lived to stay usable across a dev session.
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export type SessionPayload = {
  sid?: string;
  sub: string;
  email: string;
  isAdmin: boolean;
  entitlements: Entitlements;
  // Set automatically by jose's setIssuedAt() below (seconds since epoch).
  // IA-003: compared against profiles.auth_revoked_before so a session
  // issued before a soft-delete (or before an admin restore) is denied
  // even though the JWT itself still verifies — see parentAccessDecision.
  iat?: number;
  exp?: number;
};

function getSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET is not set — add it to .env.local (see .env.local.example).",
    );
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload, sid: payload.sid ?? crypto.randomUUID() })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS)
    .sign(getSecretKey());
}

export async function verifySessionToken(
  token: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

// Server Actions / Route Handlers only — `cookies()` is mutable there.
export async function setSessionCookie(payload: SessionPayload) {
  const token = await signSession(payload);
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie() {
  cookies().delete(SESSION_COOKIE);
}

// Safe in Server Components (read-only) as well as Actions/Route Handlers.
export async function getSession(): Promise<SessionPayload | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}
