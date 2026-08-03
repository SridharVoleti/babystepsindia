import { getSession, type SessionPayload } from "@/lib/auth/session";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import type { AuthUser } from "@/lib/auth/auth-adapter";
import { sqliteParentProfileStore } from "@/lib/db/parent-profile-store";
import {
  ensureParentProfile,
  parentAccessDecision,
  type ParentAccessAllowed,
  type ParentAccessDenied,
  type ParentProfile,
} from "@/lib/auth/parent-profile";

export type ParentContext =
  | { authenticated: false }
  | {
      authenticated: true;
      session: SessionPayload;
      user: AuthUser | null;
      profile: ParentProfile;
      decision: ParentAccessAllowed | ParentAccessDenied;
    };

// Shared by both the redirect-based page guards (guards.ts) and the
// JSON-response API guard (api-guard.ts) so the session/verified-email/
// account-status/onboarding-recovery logic lives in exactly one place.
export async function loadParentContext(): Promise<ParentContext> {
  const session = await getSession();
  if (!session) {
    return { authenticated: false };
  }

  const user = await sqliteAuthAdapter.getUserById(session.sub);
  const { profile } = await ensureParentProfile(sqliteParentProfileStore, session.sub);
  const decision = parentAccessDecision({
    emailVerified: user?.emailVerified ?? false,
    profile,
    sessionIssuedAt: session.iat,
  });

  return { authenticated: true, session, user, profile, decision };
}
