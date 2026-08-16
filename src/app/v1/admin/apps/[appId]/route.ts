import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AppRegistryError, appRegistryErrorStatus } from "@/lib/app-registry/validation";
import { editApp, getApp } from "@/lib/db/app-registry-repo";

export async function GET(_request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.app.read");
  if (!guard.ok) return guard.response;

  const app = getApp(params.appId);
  if (!app) {
    return NextResponse.json({ error: "APP_NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json(app);
}

export async function PATCH(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.app.update");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`app-registry-edit:${guard.session.sub}`, 30, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  // Patch allows mutable metadata only — assertOnlyMutableFields (inside
  // editApp) rejects id/appKey/registryStatus/version/timestamps outright
  // rather than silently ignoring them (AT-AR-001-05/27).
  try {
    const app = editApp(guard.session.sub, params.appId, body as Record<string, unknown> & {
      expectedVersion: number;
      idempotencyKey: string;
    });
    return NextResponse.json(app);
  } catch (error) {
    if (error instanceof AppRegistryError) {
      return NextResponse.json({ error: error.code }, { status: appRegistryErrorStatus(error.code) });
    }
    throw error;
  }
}
