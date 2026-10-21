import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { listLearnerAppsForAdmin } from "@/lib/db/learner-app-admin-repo";

export async function GET(request: Request) {
  const guard = await requireAdminApi("admin.learner_app.list");
  if (!guard.ok) return guard.response;
  const search = new URL(request.url).searchParams.get("search") ?? undefined;
  const learnerApps = await listLearnerAppsForAdmin(search);
  return NextResponse.json({ learnerApps }, { headers: { "Cache-Control": "private, no-store" } });
}
