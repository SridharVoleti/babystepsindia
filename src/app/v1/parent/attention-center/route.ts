import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { composeParentAttentionList, ParentAttentionRequestError } from "@/lib/parent-attention/service";

function matchesEtag(header: string | null, etag: string) {
  if (!header) return false;
  return header.split(",").map((value) => value.trim().replace(/^W\//, "")).includes(etag);
}

// API-PD-004: GET /v1/parent/attention-center — the frozen filtered/paginated
// attention endpoint (PD3-G01/G03/G04/G05). Parent identity is server-derived
// from the authenticated session, never a query parameter.
export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.attention.read");
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  try {
    const attention = await composeParentAttentionList(guard.parent.session.sub, {
      learnerId: url.searchParams.get("learnerId") ?? undefined,
      category: url.searchParams.get("category") ?? undefined,
      severity: url.searchParams.get("severity") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    }, new Date());
    const etag = `"${attention.version}"`;
    const headers = new Headers({ "Cache-Control": "private, no-cache", ETag: etag, Vary: "Cookie" });
    if (matchesEtag(request.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, { status: 304, headers });
    }
    return NextResponse.json({
      attentionVersion: attention.version,
      composedAt: attention.composedAt,
      nextRecheckAt: attention.nextRecheckAt,
      summary: attention.summary,
      items: attention.items,
      partialErrors: attention.partialErrors,
      nextCursor: attention.nextCursor,
    }, { headers });
  } catch (error) {
    const code = error instanceof ParentAttentionRequestError ? error.code : "ATTENTION_LIST_FAILED";
    return NextResponse.json({ error: code }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
