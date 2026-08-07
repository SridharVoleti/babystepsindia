import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { getPublication } from "@/lib/deployment-production/service";

const ENVIRONMENTS = ["development", "staging", "production"] as const;

export async function GET(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("app_deployment_bind");
  if (!guard.ok) return guard.response;
  const publications = ENVIRONMENTS.map((environment) => getPublication(params.appId, environment)).filter(Boolean);
  return NextResponse.json({ publications });
}
