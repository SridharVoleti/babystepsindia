import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { getPublication } from "@/lib/deployment-production/service";

const ENVIRONMENTS = ["development", "staging", "production"] as const;

export async function GET(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.deployment.deployments.read");
  if (!guard.ok) return guard.response;
  const publications = (await Promise.all(ENVIRONMENTS.map((environment) => getPublication(params.appId, environment)))).filter(Boolean);
  return NextResponse.json({ publications });
}
