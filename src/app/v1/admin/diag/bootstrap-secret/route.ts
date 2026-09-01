import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";

// TEMPORARY diagnostic route, staff-only. Reports only presence/validity of
// APP_LAUNCH_BOOTSTRAP_SECRET (never the value itself) -- added to answer
// "is this already set on babystepsindia's Vercel" without exposing the
// secret. Delete this route once answered (see chat, 2026-09-01).
export async function GET() {
  const guard = await requireAdminApi("admin.deployment.release.deploy_staging");
  if (!guard.ok) return guard.response;
  const value = process.env.APP_LAUNCH_BOOTSTRAP_SECRET;
  return NextResponse.json({ set: !!value, length: value?.length ?? 0, validLength: !!value && value.length >= 32 });
}
