import { NextResponse } from "next/server";
import { applyEmailChangeToken, finalizeEmailChange } from "@/lib/db/account-security-repo";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { setSessionCookie } from "@/lib/auth/session";
import { getEntitlementsForUser } from "@/lib/db/subscriptions";

// IA-003: the link an email-change verification email points to. Token
// ownership alone is sufficient proof of identity to establish a session
// here, matching how /auth/confirm (IA-001) already treats a valid
// verification link as sufficient — this may run on a different device
// than the one that requested the change (checking a new inbox), so it
// doesn't require an existing session.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const token = searchParams.get("token");

  const applied = token ? await applyEmailChangeToken(token) : { ok: false as const };
  if (!applied.ok) {
    return NextResponse.redirect(`${origin}/auth-code-error`);
  }

  // Reconciliation step — see account-security-repo.ts. Safe to call even
  // on a replayed callback (AT-IA-003-05/14): a no-op if already archived.
  await finalizeEmailChange(applied.parentUserId);

  const user = await sqliteAuthAdapter.getUserById(applied.parentUserId);
  if (user) {
    await setSessionCookie({
      sub: user.id,
      email: user.email,
      isAdmin: user.isAdmin,
      entitlements: await getEntitlementsForUser(user.id),
    });
  }

  return NextResponse.redirect(`${origin}/account/security`);
}
