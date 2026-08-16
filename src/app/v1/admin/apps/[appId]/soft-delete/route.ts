import { NextResponse } from "next/server";
import { requireAdminApi, requireReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AppRegistryError, appRegistryErrorStatus } from "@/lib/app-registry/validation";
import { softDeleteApp } from "@/lib/db/app-registry-repo";

// AC15/AC22: reauth, app_registry_soft_delete permission, mandatory
// reason code, and exact app_key confirmation.
export async function POST(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.app.delete");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`app-registry-soft-delete:${guard.session.sub}`, 10, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const reauthFailure = requireReauth(guard.session);


  if (reauthFailure) return reauthFailure;

  const reasonCode = typeof body.reasonCode === "string" ? body.reasonCode.trim() : "";
  if (!reasonCode) {
    return NextResponse.json({ error: "APP_METADATA_INVALID", message: "A reason code is required." }, { status: 400 });
  }

  try {
    const app = softDeleteApp(guard.session.sub, params.appId, {
      expectedVersion: Number(body.expectedVersion),
      idempotencyKey: String(body.idempotencyKey ?? ""),
      reasonCode,
      reasonNote: typeof body.reasonNote === "string" ? body.reasonNote : null,
      confirmationAppKey: String(body.confirmationAppKey ?? ""),
    });
    return NextResponse.json(app);
  } catch (error) {
    if (error instanceof AppRegistryError) {
      return NextResponse.json({ error: error.code }, { status: appRegistryErrorStatus(error.code) });
    }
    throw error;
  }
}
