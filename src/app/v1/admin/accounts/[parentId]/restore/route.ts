import { NextResponse } from "next/server";
import { requireAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";
import { sqliteParentProfileStore } from "@/lib/db/parent-profile-store";
import { restoreAccount } from "@/lib/db/account-security-repo";

// AD-001: Platform Administrator + recent two-factor reauth (business
// rules 50, 56, 63 — account restoration is explicitly a sensitive
// action). Acts on an arbitrary parentId on the staff member's authority;
// IA-003's restoreAccount remains the sole authority for the restoration
// business logic itself, this route only gates who may call it.
export async function POST(request: Request, { params }: { params: { parentId: string } }) {
  const guard = await requireAdminApi("admin.account.restore");
  if (!guard.ok) return guard.response;
  const reauthFailure = requireStaffSensitiveReauth(guard.session);
  if (reauthFailure) return reauthFailure;

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

  restoreAccount(params.parentId, guard.session.staffAccountId, reason);

  return NextResponse.json({ ok: true });
}
