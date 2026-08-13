import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { composeParentAttention } from "@/lib/parent-attention/service";

function matchesEtag(header: string | null, etag: string) {
  if (!header) return false;
  return header.split(",").map((value) => value.trim().replace(/^W\//, "")).includes(etag);
}

// PD-003: parent identity is server-derived from the authenticated session,
// never a parentId query parameter. Reads only — composeParentAttention
// never writes.
export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.attention.read");
  if (!guard.ok) return guard.response;
  const attention = composeParentAttention(guard.parent.session.sub, new Date());
  const etag = `"${attention.version}"`;
  const headers = new Headers({ "Cache-Control": "private, no-cache", ETag: etag, Vary: "Cookie" });
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json(attention, { headers });
}
