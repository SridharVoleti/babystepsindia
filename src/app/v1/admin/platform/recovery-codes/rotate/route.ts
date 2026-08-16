import { NextResponse } from "next/server";
import { requireAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";
import { rotateRecoveryCodes } from "@/lib/platform-governance/recovery-codes";

// API-AD-029: Platform Administrator + <=10m two-factor reauth invalidates
// every currently-active code and returns a fresh set exactly once (rules
// 67-68 — never retrievable again after this response).
export async function POST() {
  const guard = await requireAdminApi("admin.platform.recovery_codes.rotate");
  if (!guard.ok) return guard.response;
  const reauthFailure = requireStaffSensitiveReauth(guard.session);
  if (reauthFailure) return reauthFailure;

  const result = rotateRecoveryCodes(guard.session.staffAccountId);
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
