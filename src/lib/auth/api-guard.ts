import { NextResponse } from "next/server";
import type { SessionPayload } from "@/lib/auth/session";
import type { AuthUser } from "@/lib/auth/auth-adapter";
import type { ParentProfile } from "@/lib/auth/parent-profile";
import { loadParentContext } from "@/lib/auth/parent-context";
import { createClient as createSupabaseClient } from "@/lib/supabase/server";
import { resolveDbClient } from "@/lib/db-client";
import { parentAccessDecision } from "@/lib/auth/parent-profile";

export type ApiParentContext = {
  session: SessionPayload;
  user: AuthUser;
  profile: ParentProfile;
};

export type ApiGuardResult =
  | { ok: true; context: ApiParentContext }
  | { ok: false; response: NextResponse };

export async function getVerifiedSupabaseParentContext(): Promise<ApiGuardResult> {
  const supabase = createSupabaseClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user || !user.email) {
    return { ok: false, response: NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 }) };
  }

  const profile = await resolveDbClient().get<ParentProfile>(
    "select id, account_status, onboarding_status, auth_revoked_before from profiles where id = ?",
    [user.id],
  );
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData.session;
  const issuedAt = typeof session?.user?.aud === "string" && session.expires_at
    ? session.expires_at - (session.expires_in ?? 3600)
    : undefined;
  const decision = parentAccessDecision({
    emailVerified: !!user.email_confirmed_at,
    profile: profile ?? null,
    sessionIssuedAt: issuedAt,
  });
  if (!decision.allowed || !profile) {
    const status = decision.code === "SESSION_REVOKED" ? 401 : 403;
    return { ok: false, response: NextResponse.json({ error: decision.code }, { status }) };
  }

  return {
    ok: true,
    context: {
      session: {
        sub: user.id,
        sid: session?.access_token ? `supabase:${user.id}` : undefined,
        did: session?.access_token ? `supabase:${user.id}` : undefined,
        email: user.email,
        isAdmin: false,
        entitlements: { bundle: false, products: [] },
        iat: issuedAt,
      },
      user: { id: user.id, email: user.email, emailVerified: true, isAdmin: false },
      profile,
    },
  };
}

// JSON-response counterpart to guards.ts's redirect-based checks — same
// underlying session/verified-email/account-status logic (loadParentContext),
// for route handlers that must return a structured error instead of
// redirecting a browser navigation.
export async function requireApiParent(): Promise<ApiGuardResult> {
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    return getVerifiedSupabaseParentContext();
  }
  const context = await loadParentContext();

  if (!context.authenticated) {
    return { ok: false, response: NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 }) };
  }

  if (!context.decision.allowed) {
    // SESSION_REVOKED: the account may be fine — this token just predates
    // a revocation event (e.g. an admin restore) — so re-authenticating
    // would fix it. 401 signals that; 403 (suspended/deleted/etc.) doesn't.
    const status = context.decision.code === "SESSION_REVOKED" ? 401 : 403;
    return {
      ok: false,
      response: NextResponse.json({ error: context.decision.code }, { status }),
    };
  }

  // context.decision.allowed guarantees emailVerified, which guarantees
  // sqliteAuthAdapter.getUserById resolved a user — safe to assert non-null.
  return {
    ok: true,
    context: { session: context.session, user: context.user!, profile: context.profile },
  };
}
