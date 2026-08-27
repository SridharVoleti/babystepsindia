import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { staffFailure } from "@/lib/staff-identity/route-helpers";
import { passwordOnlyStaffReauth } from "@/lib/staff-identity/auth-service";

// Temporary simplification (2026-08-27, explicit request): password-only
// sensitive-action reauth, no passkey ceremony — see
// passwordOnlyStaffReauth's own comment (auth-service.ts) for how to
// switch back to the passkey-based flow later.
export async function POST(request: Request) {
  const guard = await requireAdminApi("admin.staff.passkey.assertion_options");
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.currentPassword !== "string") {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    await passwordOnlyStaffReauth({
      staffAccountId: guard.session.staffAccountId,
      staffSessionId: guard.session.sessionId,
      currentPassword: body.currentPassword,
    });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return staffFailure(error);
  }
}
