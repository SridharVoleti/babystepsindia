import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { composeParentAttentionSummary, ParentAttentionRequestError } from "@/lib/parent-attention/service";

function matchesEtag(header: string | null, etag: string) {
  if (!header) return false;
  return header.split(",").map((value) => value.trim().replace(/^W\//, "")).includes(etag);
}

// API-PD-005: GET /v1/parent/attention-summary — the frozen compact-summary
// endpoint (PD3-G01/G02/G06/G07), same source policy as attention-center
// (composeParentAttention), scoped by optional learnerId and a
// caller-controlled bounded preview limit (<=5).
export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.attention.summary.read");
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  try {
    const summary = await composeParentAttentionSummary(guard.parent.session.sub, {
      learnerId: url.searchParams.get("learnerId") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    }, new Date());
    const etag = `"${summary.version}"`;
    const headers = new Headers({ "Cache-Control": "private, no-cache", ETag: etag, Vary: "Cookie" });
    if (matchesEtag(request.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, { status: 304, headers });
    }
    return NextResponse.json({
      actionRequiredCount: summary.actionRequiredCount,
      attentionCount: summary.attentionCount,
      infoCount: summary.infoCount,
      preview: summary.preview,
      attentionVersion: summary.version,
    }, { headers });
  } catch (error) {
    const code = error instanceof ParentAttentionRequestError ? error.code : "ATTENTION_SUMMARY_FAILED";
    return NextResponse.json({ error: code }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
