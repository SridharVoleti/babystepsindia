import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { listRecoveryIncidents } from "@/lib/progress-recovery/service";

// PR-002: exact progress-operations read permission — safe metadata only,
// no raw pendingState/current-state on this table to begin with.
export async function GET(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.progress_recovery.incidents.read");
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  return NextResponse.json(listRecoveryIncidents(params.appId, {
    status: status === "open" || status === "resolved" ? status : undefined,
    cursor, limit: limitParam ? Number(limitParam) : undefined,
  }), { headers: { "Cache-Control": "no-store" } });
}
