import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { AppRegistryError, appRegistryErrorStatus } from "@/lib/app-registry/validation";
import { createApp, listApps } from "@/lib/db/app-registry-repo";
import type { AppRegistryStatus } from "@/lib/db/types";

const VALID_STATUSES: AppRegistryStatus[] = ["draft", "active", "soft_deleted"];

// AC29: soft-deleted apps are excluded from routine list queries unless
// includeSoftDeleted=true is requested by an authorized admin.
export async function GET(request: Request) {
  const guard = await requireAdminApi("admin.app.list");
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get("status");
  const status = VALID_STATUSES.includes(statusParam as AppRegistryStatus)
    ? (statusParam as AppRegistryStatus)
    : undefined;
  const includeSoftDeleted = searchParams.get("includeSoftDeleted") === "true";
  const search = searchParams.get("search") ?? undefined;

  const apps = await listApps({ status, includeSoftDeleted, search });
  return NextResponse.json({ apps });
}

export async function POST(request: Request) {
  const guard = await requireAdminApi("admin.app.create");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`app-registry-create:${guard.session.sub}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  // Create strict payload: only the documented create fields are ever
  // read — id/status/version/timestamps are never accepted from the
  // client (business rule 18, API contract "excludes id/status/version/
  // timestamps").
  try {
    const app = await createApp(guard.session.sub, {
      appKey: String(body.appKey ?? ""),
      displayName: String(body.displayName ?? ""),
      shortDescription: typeof body.shortDescription === "string" ? body.shortDescription : null,
      iconAssetKey: typeof body.iconAssetKey === "string" ? body.iconAssetKey : null,
      category: typeof body.category === "string" ? body.category : null,
      owningTeam: typeof body.owningTeam === "string" ? body.owningTeam : null,
      internalNotes: typeof body.internalNotes === "string" ? body.internalNotes : null,
      idempotencyKey: String(body.idempotencyKey ?? ""),
    });
    return NextResponse.json(app, { status: 201 });
  } catch (error) {
    if (error instanceof AppRegistryError) {
      return NextResponse.json({ error: error.code }, { status: appRegistryErrorStatus(error.code) });
    }
    throw error;
  }
}
