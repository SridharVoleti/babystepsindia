import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { sqliteParentProfileStore } from "@/lib/db/parent-profile-store";
import { restoreAccount } from "@/lib/db/account-security-repo";

// Admin-only, requires a reason (business rule 14 / AT-IA-003-13). Does
// not go through requireApiParent — that guard is for a parent acting on
// their own profile; this route acts on an arbitrary parentId on an
// admin's authority, checked directly against session.isAdmin the same
// way guards.requireAdmin() does for admin pages.
export async function POST(request: Request, { params }: { params: { parentId: string } }) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  if (!session.isAdmin) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const target = await sqliteParentProfileStore.find(params.parentId);
  if (!target) {
    return NextResponse.json({ error: "PARENT_NOT_FOUND" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return NextResponse.json({ error: "REASON_REQUIRED" }, { status: 400 });
  }

  restoreAccount(params.parentId, session.sub, reason);

  return NextResponse.json({ ok: true });
}
