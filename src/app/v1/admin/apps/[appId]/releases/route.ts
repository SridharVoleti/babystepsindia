import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { listReleases } from "@/lib/deployment-release/service";

export async function GET(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("app_deployment_bind");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ releases: listReleases(params.appId) });
}
