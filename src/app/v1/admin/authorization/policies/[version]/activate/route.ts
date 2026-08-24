import { NextResponse } from "next/server";
import {
  activateAuthorizationPolicyBundle,
  AuthorizationPolicyBundleError,
} from "@/lib/authorization/policy-bundles";
import { requireAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";

const statusByCode: Record<string, number> = {
  POLICY_ACTIVATION_FORBIDDEN: 403,
  POLICY_ACTIVATION_REAUTH_REQUIRED: 403,
  POLICY_BUNDLE_NOT_FOUND: 404,
  POLICY_BUNDLE_INTEGRITY_FAILED: 409,
};

export async function POST(request: Request, { params }: { params: { version: string } }) {
  const guard = await requireAdminApi("admin.authorization.policy.activate");
  if (!guard.ok) return guard.response;
  const reauthFailure = requireStaffSensitiveReauth(guard.session);
  if (reauthFailure) return reauthFailure;

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 }); }
  if (typeof body.reason !== "string" || body.reason.trim().length < 20 || Object.keys(body).some((key) => key !== "reason")) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const policy = activateAuthorizationPolicyBundle({
      version: params.version,
      activatedBy: guard.session.staffAccountId,
      staffSessionId: guard.session.sessionId,
      reason: body.reason.trim(),
    });
    return NextResponse.json({ policy }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthorizationPolicyBundleError) {
      return NextResponse.json({ error: error.code }, { status: statusByCode[error.code] ?? 400,
        headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}
