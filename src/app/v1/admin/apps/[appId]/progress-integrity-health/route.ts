import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { getProgressIntegrityHealth } from "@/lib/progress-integrity/incidents";

// PR-004 rule 74: aggregate counts/classification/age only, no learner
// reference — safe to expose to any admin holding the operations permission.
export async function GET(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.progress_integrity.health.read");
  if (!guard.ok) return guard.response;
  const environment = new URL(request.url).searchParams.get("environment") ?? undefined;
  return NextResponse.json(getProgressIntegrityHealth(params.appId, environment));
}
