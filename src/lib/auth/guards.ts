import { redirect } from "next/navigation";
import { getSession, type SessionPayload } from "@/lib/auth/session";
import { loadParentContext } from "@/lib/auth/parent-context";
import type { ParentProfile } from "@/lib/auth/parent-profile";

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
// Does NOT gate on onboarding_status — used by /onboarding itself as well
// as post-onboarding routes, via the two wrappers below.
async function requireActiveVerifiedParent(): Promise<{
  session: SessionPayload;
  profile: ParentProfile;
}> {
  const context = await loadParentContext();
  if (!context.authenticated) {
    redirect("/login");
  }

  if (!context.decision.allowed) {
    if (context.decision.code === "EMAIL_NOT_VERIFIED") {
      redirect("/verify-email");
    }
    // IA-003: the account itself may be fine (e.g. just restored by an
    // admin) — this specific browser session just predates that and
    // needs a fresh login, not the "account unavailable" messaging that
    // suspended/deleted accounts get.
    if (context.decision.code === "SESSION_REVOKED") {
      redirect("/login");
    }
    redirect("/account-suspended");
  }

  return { session: context.session, profile: context.profile };
}

// IA-002 AC1: a verified, active parent whose profile is still
// profile_pending is directed to onboarding before reaching any other
// protected route (e.g. /account).
export async function requireVerifiedParent(): Promise<{
  session: SessionPayload;
  profile: ParentProfile;
}> {
  const context = await requireActiveVerifiedParent();
  if (context.profile.onboarding_status === "profile_pending") {
    redirect("/onboarding");
  }
  return context;
}

// For the /onboarding page itself — same verified/active checks, but no
// onboarding_status redirect (that would loop). The page redirects
// forward itself once onboarding_status has moved past profile_pending.
export async function requireOnboardingParent(): Promise<{
  session: SessionPayload;
  profile: ParentProfile;
}> {
  return requireActiveVerifiedParent();
}

export async function requireAdmin(): Promise<SessionPayload> {
  const session = await requireSession();
  if (!session.isAdmin) {
    redirect("/account");
  }
  return session;
}
