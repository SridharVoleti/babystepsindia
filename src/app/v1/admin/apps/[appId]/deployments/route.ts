import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { resolveDbClient } from "@/lib/db-client";
import { getPublication } from "@/lib/deployment-production/service";

const ENVIRONMENTS = ["development", "staging", "production"] as const;

export async function GET(request: Request, { params }: { params: { appId: string } }) {
  const guard = await requireAdminApi("admin.deployment.deployments.read");
  if (!guard.ok) return guard.response;
  const publications = (await Promise.all(ENVIRONMENTS.map((environment) => getPublication(params.appId, environment)))).filter(Boolean);
  // Admin-only diagnostics: a failed promotion otherwise surfaces just a
  // generic code, with the provider's real error only in the database.
  const recentFailures = await resolveDbClient().all(
    `select environment, status, verified_origin, validation_summary_json, started_at
     from app_deployments where app_id = ? and status = 'failed' order by started_at desc limit 5`,
    [params.appId],
  );
  return NextResponse.json({ publications, recentFailures });
}
