import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import {
  composeParentLearnerDetailContract,
  ParentLearnerDetailError,
  ParentLearnerDetailStaleSelectionError,
} from "@/lib/parent-learner-detail/service";

function matchesEtag(header: string | null, etag: string) {
  if (!header) return false;
  return header.split(",").map((value) => value.trim().replace(/^W\//, "")).includes(etag);
}

// API-PD-002: GET /v1/parent/learners/{learnerId}/detail?section=current|past&appId?
// PD2-G01/G03/G04/G05: the frozen route, request contract and 409
// stale-selection semantics — composed entirely from the existing
// composeParentLearnerDetail/composeParentAppDetail read path.
export async function GET(request: Request, { params }: { params: { learnerId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.detail.read", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const sectionParam = url.searchParams.get("section") ?? "current";
  if (sectionParam !== "current" && sectionParam !== "past") {
    return NextResponse.json({ error: "INVALID_SECTION" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const appIdParam = url.searchParams.get("appId") ?? undefined;

  try {
    const detail = await composeParentLearnerDetailContract(guard.parent.session.sub, params.learnerId,
      { section: sectionParam, appId: appIdParam }, new Date());
    const etag = `"${detail.detailVersion}"`;
    const headers = { "Cache-Control": "private, no-cache", ETag: etag, Vary: "Cookie" };
    const conditional = request.headers.get("if-none-match")?.split(",")
      .map((value) => value.trim().replace(/^W\//, "")).includes(etag);
    if (conditional) return new NextResponse(null, { status: 304, headers });
    return NextResponse.json(detail, { headers });
  } catch (error) {
    if (error instanceof ParentLearnerDetailStaleSelectionError) {
      return NextResponse.json({ error: "STALE_SELECTION" }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    const code = error instanceof ParentLearnerDetailError ? error.code : "LEARNER_DETAIL_FAILED";
    return NextResponse.json({ error: code }, { status: code === "RESOURCE_NOT_FOUND" ? 404 : 400,
      headers: { "Cache-Control": "no-store" } });
  }
}
