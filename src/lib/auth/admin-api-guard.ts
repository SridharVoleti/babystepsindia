import { NextResponse } from "next/server";
import { getSession, type SessionPayload } from "@/lib/auth/session";
import { hasAdminPermission } from "@/lib/auth/admin-permissions";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import type { AppRegistryPermission } from "@/lib/db/types";

export type AdminApiGuardResult =
  | { ok: true; session: SessionPayload }
  | { ok: false; response: NextResponse };

// Checks the coarse is_admin flag and, when given, the specific granular
// permission (business rule 2 / AT-AR-001-16).
export async function requireAdminApi(permission?: AppRegistryPermission): Promise<AdminApiGuardResult> {
  const session = await getSession();
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 }) };
  }
  if (!session.isAdmin) {
    return { ok: false, response: NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }) };
  }
  if (permission && !hasAdminPermission(session.sub, permission)) {
    return { ok: false, response: NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }) };
  }
  return { ok: true, session };
}

// Activate/soft-delete/restore require "recent reauthentication" —
// re-verified on every sensitive call rather than caching a
// reauthenticated-at timestamp, the same choice IA-003 made for
// password/email-change/soft-delete.
export async function verifyReauth(email: string, currentPassword: string): Promise<boolean> {
  const user = await sqliteAuthAdapter.signInWithPassword(email, currentPassword);
  return !!user;
}
