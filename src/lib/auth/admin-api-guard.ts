import { NextResponse } from "next/server";
import type { AuthorizationAction } from "@/lib/authorization/modes";
import { requireAdminApi as requireStaffAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";
import { findStaffByIdAsync } from "@/lib/staff-identity/accounts-repo";
import { hasLiveReauthReceipt } from "@/lib/staff-identity/reauth-service";
import { isSuperAdminDisplay } from "@/lib/staff-identity/roles";
import { createAdministratorPrincipal, type AdministratorPrincipal } from "@/lib/authorization/principals";

// AD-001: every existing admin route now resolves against the staff
// identity/role system instead of the retired coarse is_admin flag +
// freeform admin_permissions table. This file is the single choke point
// that lets ~50 existing call sites keep using `requireAdminApi(...)`/
// `guard.session.sub`/`guard.session.email` with only their permission
// ARGUMENT changed (legacy string -> AU-001 canonical action key) — see
// src/lib/staff-identity/roles.ts for the role -> action mapping this now
// resolves through.
export type AdminSessionView = {
  // Kept as `sub`/`email` (rather than staffAccountId/normalizedEmail) so
  // the ~50 pre-existing call sites built against the old parent-session
  // shape don't need a field rename, only their permission argument.
  sub: string;
  email: string;
  staffAccountId: string;
  sessionId: string;
  roleKeys: string[];
  isAdmin: true;
};

export type AdminApiGuardResult =
  | { ok: true; session: AdminSessionView; principal: AdministratorPrincipal }
  | { ok: false; response: NextResponse };

export async function requireAdminApi(action: AuthorizationAction): Promise<AdminApiGuardResult> {
  const guard = await requireStaffAdminApi(action);
  if (!guard.ok) return guard;
  const staff = await findStaffByIdAsync(guard.session.staffAccountId);
  if (!staff) {
    return { ok: false, response: NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 }) };
  }
  const session: AdminSessionView = {
    sub: guard.session.staffAccountId,
    email: staff.normalized_email,
    staffAccountId: guard.session.staffAccountId,
    sessionId: guard.session.sessionId,
    roleKeys: guard.session.roleKeys,
    isAdmin: true,
  };
  return {
    ok: true,
    session,
    principal: createAdministratorPrincipal({ id: session.sub, sessionId: session.sessionId, verified: true }),
  };
}

// BR-002/AN-004: a second gate layered on top of requireAdminApi for the
// small set of actions that require holding all 4 staff roles (this
// codebase's existing "Super Admin" definition, isSuperAdminDisplay —
// previously a UI-only label, first promoted to a real authorization
// gate by AN-004). Reused as-is here rather than inventing a second
// "unrestricted" concept.
export async function requireSuperAdminApi(action: AuthorizationAction): Promise<AdminApiGuardResult> {
  const guard = await requireAdminApi(action);
  if (!guard.ok) return guard;
  if (!isSuperAdminDisplay(guard.session.roleKeys)) {
    return { ok: false, response: NextResponse.json({ error: "SUPER_ADMIN_REQUIRED" }, { status: 403 }) };
  }
  return guard;
}

// AD-001 business rules 60-69: replaces the legacy per-call password-only
// verifyReauth with a check against a live <=10-minute two-factor
// (password + fresh passkey) reauth receipt — established once via
// API-AD-005/006, not re-collected on every sensitive call.
export async function requireReauth(session: { sessionId: string; staffAccountId: string }): Promise<NextResponse | null> {
  return requireStaffSensitiveReauth({ sessionId: session.sessionId, staffAccountId: session.staffAccountId });
}

// Page-render boolean counterpart to requireReauth (no NextResponse) —
// replaces the old iat-based 5-minute heuristic with a real check against
// the two-factor reauth receipt. Accepts either AdminSessionView or the
// raw StaffSessionPayload requireAdminPermission (guards.ts) returns —
// both carry sessionId/staffAccountId.
export async function hasRecentAdminAuthentication(session: { sessionId: string; staffAccountId: string }): Promise<boolean> {
  return hasLiveReauthReceipt({ staffSessionId: session.sessionId, staffAccountId: session.staffAccountId });
}
