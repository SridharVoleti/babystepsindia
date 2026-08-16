import { redirect } from "next/navigation";
import { getSession, type SessionPayload } from "@/lib/auth/session";
import { loadParentContext } from "@/lib/auth/parent-context";
import type { ParentProfile } from "@/lib/auth/parent-profile";
import { deriveAuthorizationContext, type AuthorizationAction, type EndUserAuthorizationContext } from "@/lib/authorization/modes";
import { activeRoleKeys, findStaffById } from "@/lib/staff-identity/accounts-repo";
import { roleHasCapability } from "@/lib/staff-identity/roles";
import { getStaffSession, isStaffSessionLive, type StaffSessionPayload } from "@/lib/staff-identity/session";

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

async function requireAuthorizationMode(expected: EndUserAuthorizationContext["mode"]) {
  const context = await requireVerifiedParent();
  let authorization: EndUserAuthorizationContext;
  try {
    authorization = deriveAuthorizationContext({
      parentUserId: context.session.sub,
      parentSessionId: context.session.sid,
      deviceSessionId: context.session.did,
      now: new Date(),
    });
  } catch {
    redirect("/login");
  }
  if (authorization.mode !== expected) {
    redirect(expected === "parent_management" ? "/learner" : "/account");
  }
  return { ...context, authorization };
}

export function requireParentManagement() {
  return requireAuthorizationMode("parent_management");
}

export function requireLearnerMode() {
  return requireAuthorizationMode("learner_mode");
}

// AD-001: `/admin/**` pages now require the separate staff session
// (bs_staff_session) — an authenticated parent session never confers
// admin access (business rule 104). Redirects to the staff login, not the
// parent one.
export async function requireAdmin(): Promise<StaffSessionPayload> {
  const session = await getStaffSession();
  if (!session) {
    redirect("/staff/login");
  }
  const staff = findStaffById(session.staffAccountId);
  if (!staff || !isStaffSessionLive(session, staff, new Date())) {
    redirect("/staff/login");
  }
  return { ...session, roleKeys: activeRoleKeys(session.staffAccountId) };
}

export async function requireAdminPermission(action: AuthorizationAction): Promise<StaffSessionPayload> {
  const session = await requireAdmin();
  if (!roleHasCapability(session.roleKeys, action)) {
    redirect("/admin");
  }
  return session;
}
