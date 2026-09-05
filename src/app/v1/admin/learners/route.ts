import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { listAllLearnersForAdmin } from "@/lib/db/learner-repo";

export async function GET(request: Request) {
  const guard = await requireAdminApi("admin.learner.list");
  if (!guard.ok) return guard.response;
  const search = new URL(request.url).searchParams.get("search") ?? undefined;
  const learners = await listAllLearnersForAdmin(search);
  return NextResponse.json({ learners }, { headers: { "Cache-Control": "private, no-store" } });
}
