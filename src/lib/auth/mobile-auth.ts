import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { getEntitlementsForUser } from "@/lib/db/subscriptions";
import { signSession, SESSION_TTL_SECONDS } from "@/lib/auth/session";

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_ATTEMPTS = 5;

export type MobileLoginResult =
  | { ok: true; accessToken: string; expiresIn: number; parentId: string; email: string }
  | { ok: false; error: "RATE_LIMITED" | "INVALID_CREDENTIALS" };

// Mobile counterpart to signInAction ((auth)/actions.ts): identical rate
// limit (business rule parity, not a coincidence) and identical
// deliberately-generic failure (AC8 / AT-IA-001-07 — never reveals whether
// the email exists), sharing the exact same credential check and session
// payload shape. The only difference is the transport: a bearer token in
// the JSON body instead of a Set-Cookie header, since a mobile client has
// no cookie jar tied to this origin.
export async function authenticateForMobile(email: string, password: string): Promise<MobileLoginResult> {
  if (!checkRateLimit(`login:${email.toLowerCase()}`, RATE_LIMIT_ATTEMPTS, RATE_LIMIT_WINDOW_MS)) {
    return { ok: false, error: "RATE_LIMITED" };
  }

  const user = await sqliteAuthAdapter.signInWithPassword(email, password);
  if (!user) {
    return { ok: false, error: "INVALID_CREDENTIALS" };
  }

  const accessToken = await signSession({
    sub: user.id,
    email: user.email,
    isAdmin: user.isAdmin,
    entitlements: await getEntitlementsForUser(user.id),
  });

  return { ok: true, accessToken, expiresIn: SESSION_TTL_SECONDS, parentId: user.id, email: user.email };
}
