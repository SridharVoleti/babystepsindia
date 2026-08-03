import { NextResponse } from "next/server";
import type { SessionPayload } from "@/lib/auth/session";
import type { AuthUser } from "@/lib/auth/auth-adapter";
import type { ParentProfile } from "@/lib/auth/parent-profile";
import { loadParentContext } from "@/lib/auth/parent-context";

export type ApiParentContext = {
  session: SessionPayload;
  user: AuthUser;
  profile: ParentProfile;
};

export type ApiGuardResult =
  | { ok: true; context: ApiParentContext }
  | { ok: false; response: NextResponse };

// JSON-response counterpart to guards.ts's redirect-based checks — same
// underlying session/verified-email/account-status logic (loadParentContext),
// for route handlers that must return a structured error instead of
// redirecting a browser navigation.
export async function requireApiParent(): Promise<ApiGuardResult> {
  const context = await loadParentContext();

  if (!context.authenticated) {
    return { ok: false, response: NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 }) };
  }

  if (!context.decision.allowed) {
    return {
      ok: false,
      response: NextResponse.json({ error: context.decision.code }, { status: 403 }),
    };
  }

  // context.decision.allowed guarantees emailVerified, which guarantees
  // sqliteAuthAdapter.getUserById resolved a user — safe to assert non-null.
  return {
    ok: true,
    context: { session: context.session, user: context.user!, profile: context.profile },
  };
}
