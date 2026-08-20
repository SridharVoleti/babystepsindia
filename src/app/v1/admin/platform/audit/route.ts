import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/staff-identity/guard";
import { queryPrivilegedAudit } from "@/lib/platform-governance/audit-viewer";
import { PlatformGovernanceError, platformGovernanceErrorStatus } from "@/lib/platform-governance/contracts";

// API-AD-030: read-only, bounded, allowlisted-filter privileged audit
// query — no free-form SQL/filter expression is accepted (rule 82).
export async function GET(request: Request) {
  const guard = await requireAdminApi("admin.platform.audit.read");
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  try {
    const result = await queryPrivilegedAudit({
      from, to,
      staffAccountId: url.searchParams.get("staffId") ?? undefined,
      roleKey: url.searchParams.get("roleKey") ?? undefined,
      canonicalAction: url.searchParams.get("action") ?? undefined,
      result: url.searchParams.get("result") ?? undefined,
      caseId: url.searchParams.get("caseId") ?? undefined,
      operationChangeId: url.searchParams.get("operationChangeId") ?? undefined,
      resourceType: url.searchParams.get("resourceType") ?? undefined,
      resourceRef: url.searchParams.get("resourceRef") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof PlatformGovernanceError) {
      return NextResponse.json({ error: error.code }, { status: platformGovernanceErrorStatus(error.code) });
    }
    throw error;
  }
}
