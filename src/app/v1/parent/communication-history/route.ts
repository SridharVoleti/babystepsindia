import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { composeParentCommunicationHistory, ParentCommunicationHistoryRequestError } from "@/lib/notification-history/service";

function matchesEtag(header: string | null, etag: string) {
  if (!header) return false;
  return header.split(",").map((value) => value.trim().replace(/^W\//, "")).includes(etag);
}

// API-NT-006: GET /v1/parent/communication-history — the frozen 13-month
// parent transactional-communication history. Parent identity is always
// server-derived from the authenticated session, never a query parameter
// (rules 11-12).
export async function GET(request: Request) {
  const guard = await requireEndUserAuthorization(request, "parent.notification_history.read");
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  try {
    const history = await composeParentCommunicationHistory(guard.parent.session.sub, {
      category: url.searchParams.get("category") ?? undefined,
      learnerId: url.searchParams.get("learnerId") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    }, new Date());
    const etag = `"${history.historyVersion}"`;
    const headers = new Headers({ "Cache-Control": "private, no-cache", ETag: etag, Vary: "Cookie" });
    if (matchesEtag(request.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, { status: 304, headers });
    }
    return NextResponse.json({
      historyVersion: history.historyVersion,
      retentionMonths: history.retentionMonths,
      items: history.items,
      nextCursor: history.nextCursor,
    }, { headers });
  } catch (error) {
    const code = error instanceof ParentCommunicationHistoryRequestError ? error.code : "COMMUNICATION_HISTORY_FAILED";
    return NextResponse.json({ error: code }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}
