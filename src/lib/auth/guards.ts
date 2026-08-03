import { redirect } from "next/navigation";
import { getSession, type SessionPayload } from "@/lib/auth/session";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { sqliteParentProfileStore } from "@/lib/db/parent-profile-store";
import {
  ensureParentProfile,
  parentAccessDecision,
  type ParentProfile,
} from "@/lib/auth/parent-profile";

export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  return session;
}

// IA-001 AC3/AC9: checked live on every request (not cached in the
// session JWT) so a profile suspended mid-session is denied immediately,
// and a same-session verification/recovery takes effect right away.
export async function requireVerifiedParent(): Promise<{
  session: SessionPayload;
  profile: ParentProfile;
}> {
  const session = await requireSession();

  const user = await sqliteAuthAdapter.getUserById(session.sub);
  const { profile } = await ensureParentProfile(sqliteParentProfileStore, session.sub);

  const decision = parentAccessDecision({
    emailVerified: user?.emailVerified ?? false,
    profile,
  });

  if (!decision.allowed) {
    if (decision.code === "EMAIL_NOT_VERIFIED") {
      redirect("/verify-email");
    }
    redirect("/account-suspended");
  }

  return { session, profile };
}

export async function requireAdmin(): Promise<SessionPayload> {
  const session = await requireSession();
  if (!session.isAdmin) {
    redirect("/account");
  }
  return session;
}
