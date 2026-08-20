import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { composeParentAttentionBadge } from "@/lib/parent-attention/service";

function matchesEtag(header: string | null, etag: string) {
  if (!header) return false;
  return header.split(",").map((value) => value.trim().replace(/^W\//, "")).includes(etag);
}

// PD-004's shell badge and PD-001's dashboard preview both call this same
// compact summary — the only attention algorithm in the app (see
// src/lib/parent-attention/service.ts).
export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.attention.summary.read");
  if (!guard.ok) return guard.response;
  const badge = await composeParentAttentionBadge(guard.parent.session.sub, new Date());
  const etag = `"${badge.version}"`;
  const headers = new Headers({ "Cache-Control": "private, no-cache", ETag: etag, Vary: "Cookie" });
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json(badge, { headers });
}
