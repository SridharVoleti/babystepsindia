import { NextResponse } from "next/server";
import { requireAdminApi, verifyReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AppRegistryError, appRegistryErrorStatus } from "@/lib/app-registry/validation";
import { restoreApp } from "@/lib/db/app-registry-repo";

export async function POST(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("app_registry_restore");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`app-registry-restore:${guard.session.sub}`, 10, 15 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  if (!(await verifyReauth(guard.session.email, currentPassword))) {
    return NextResponse.json({ error: "REAUTHENTICATION_REQUIRED" }, { status: 401 });
  }

  const reasonCode = typeof body.reasonCode === "string" ? body.reasonCode.trim() : "";
  if (!reasonCode) {
    return NextResponse.json({ error: "APP_METADATA_INVALID", message: "A reason is required." }, { status: 400 });
  }

  try {
    const app = restoreApp(guard.session.sub, params.appId, {
      expectedVersion: Number(body.expectedVersion),
      idempotencyKey: String(body.idempotencyKey ?? ""),
      reasonCode,
    });
    return NextResponse.json(app);
  } catch (error) {
    if (error instanceof AppRegistryError) {
      return NextResponse.json({ error: error.code }, { status: appRegistryErrorStatus(error.code) });
    }
    throw error;
  }
}
