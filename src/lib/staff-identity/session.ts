import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { STAFF_ABSOLUTE_SESSION_MS, STAFF_CHALLENGE_TTL_MS, STAFF_IDLE_TIMEOUT_MS } from "@/lib/staff-identity/contracts";
import type { StaffAccountRow } from "@/lib/staff-identity/accounts-repo";

// AD-001 business rules 9, 103-106: a fully separate namespace from the
// parent `bs_session` cookie — an authenticated parent session never
// confers admin access, and vice versa, even in the same browser profile.
export const STAFF_SESSION_COOKIE = "bs_staff_session";

export type StaffSessionPayload = {
  staffAccountId: string;
  authUserId: string;
  sessionId: string;
  authenticationTime: number;
  mfaVerificationTime: number;
  authorizationGeneration: number;
  roleKeys: string[];
  lastActivityTime: number;
  iat?: number;
  exp?: number;
};

// A short-lived (5-minute), unsigned-cookie proof that a caller already
// completed the staff password step for a specific staffAccountId —
// returned directly in the API response body (not a cookie) and passed
// back by the client into the passkey registration/assertion routes.
// Prevents an anonymous caller from probing arbitrary staffAccountIds'
// passkey ceremonies without first proving password knowledge.
export type PendingStaffTokenPayload = {
  staffAccountId: string;
  purpose: "enrollment" | "login" | "reauth" | "staff_passkey_recovery";
  // Only set for purpose="reauth" — binds the reauth ceremony to the
  // specific already-authenticated session it's elevating.
  staffSessionId?: string;
  // AD-005 rule 40: only set for purpose="staff_passkey_recovery" — binds
  // the passkey registration this token authorizes to the exact recovery
  // session record that will be consumed once registration succeeds.
  recoverySessionId?: string;
  iat?: number;
  exp?: number;
};

function getSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not set — add it to .env.local (see .env.local.example).");
  }
  return new TextEncoder().encode(secret);
}

export async function signStaffSession(payload: StaffSessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + STAFF_ABSOLUTE_SESSION_MS / 1000)
    .sign(getSecretKey());
}

export async function verifyStaffSessionToken(token: string): Promise<StaffSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    return payload as unknown as StaffSessionPayload;
  } catch {
    return null;
  }
}

export async function setStaffSessionCookie(payload: StaffSessionPayload) {
  const token = await signStaffSession(payload);
  cookies().set(STAFF_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: STAFF_ABSOLUTE_SESSION_MS / 1000,
  });
}

export function clearStaffSessionCookie() {
  cookies().delete(STAFF_SESSION_COOKIE);
}

export async function getStaffSession(): Promise<StaffSessionPayload | null> {
  const token = cookies().get(STAFF_SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifyStaffSessionToken(token);
}

// Business rules 22-24, 38: idle timeout, absolute lifetime, AND the
// authorization-generation fast-revocation check (mirrors PD-004's
// learner_unlock_contexts.version pattern) — a stale-generation session
// dies immediately even though its JWT still cryptographically verifies.
export function isStaffSessionLive(session: StaffSessionPayload, staffRow: StaffAccountRow, now: Date): boolean {
  if (staffRow.status !== "active") return false;
  if (session.authorizationGeneration !== staffRow.authorization_generation) return false;
  const nowMs = now.getTime();
  if (nowMs - session.authenticationTime > STAFF_ABSOLUTE_SESSION_MS) return false;
  if (nowMs - session.lastActivityTime > STAFF_IDLE_TIMEOUT_MS) return false;
  return true;
}

export async function signPendingStaffToken(payload: PendingStaffTokenPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + STAFF_CHALLENGE_TTL_MS / 1000)
    .sign(getSecretKey());
}

export async function verifyPendingStaffToken(token: string): Promise<PendingStaffTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey());
    return payload as unknown as PendingStaffTokenPayload;
  } catch {
    return null;
  }
}
