import { NextResponse } from "next/server";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { setSessionCookie } from "@/lib/auth/session";
import { getEntitlementsForUser } from "@/lib/db/subscriptions";

// IA-001: the link a verification email points to. Local-dev counterpart
// of Supabase's own /auth/confirm — src/app/auth/callback/route.ts stays
// reserved for OAuth/PKCE code exchange once a real Supabase project is
// wired in.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const token = searchParams.get("token");

  const user = token ? await sqliteAuthAdapter.verifyEmail(token) : null;

  if (!user) {
    return NextResponse.redirect(`${origin}/auth-code-error`);
  }

  await setSessionCookie({
    sub: user.id,
    email: user.email,
    isAdmin: user.isAdmin,
    entitlements: getEntitlementsForUser(user.id),
  });

  return NextResponse.redirect(`${origin}/account`);
}
