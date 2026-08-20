import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/staff-identity/guard";
import { getGovernanceOverview } from "@/lib/platform-governance/dashboard";

// API-AD-026: safe governance counts/alerts/recovery-code status only.
export async function GET() {
  const guard = await requireAdminApi("admin.platform.governance.read");
  if (!guard.ok) return guard.response;
  return NextResponse.json(await getGovernanceOverview(), { headers: { "Cache-Control": "private, no-store" } });
}
