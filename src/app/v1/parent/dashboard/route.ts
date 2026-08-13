import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { composeParentDashboard } from "@/lib/parent-dashboard/service";

function matchesEtag(header: string | null, etag: string) {
  if (!header) return false;
  return header.split(",").map((value) => value.trim().replace(/^W\//, "")).includes(etag);
}

// PD-001: parent identity is server-derived from the authenticated session,
// never a parentId query parameter. Reads only — composeParentDashboard
// never reserves a session, consumes a credit, or mutates weekly usage.
export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.dashboard.read");
  if (!guard.ok) return guard.response;
  const dashboard = composeParentDashboard(guard.parent.session.sub, new Date());
  const etag = `"${dashboard.version}"`;
  const headers = new Headers({ "Cache-Control": "private, no-cache", ETag: etag, Vary: "Cookie" });
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json(dashboard, { headers });
}
