import { NextResponse } from "next/server";
import { requireAdminApi, requireReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AppRegistryError, appRegistryErrorStatus } from "@/lib/app-registry/validation";
import { activateApp } from "@/lib/db/app-registry-repo";

export async function POST(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.app.activate");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`app-registry-activate:${guard.session.sub}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const reauthFailure = await requireReauth(guard.session);


  if (reauthFailure) return reauthFailure;

  try {
    const app = await activateApp(guard.session.sub, params.appId, {
      expectedVersion: Number(body.expectedVersion),
      idempotencyKey: String(body.idempotencyKey ?? ""),
    });
    return NextResponse.json(app);
  } catch (error) {
    if (error instanceof AppRegistryError) {
      return NextResponse.json({ error: error.code }, { status: appRegistryErrorStatus(error.code) });
    }
    throw error;
  }
}
