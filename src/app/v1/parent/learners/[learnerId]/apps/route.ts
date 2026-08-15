import { NextResponse } from "next/server";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { listParentLearnerAppSelectors, ParentLearnerDetailError } from "@/lib/parent-learner-detail/service";

function matchesEtag(header: string | null, etag: string) {
  if (!header) return false;
  return header.split(",").map((value) => value.trim().replace(/^W\//, "")).includes(etag);
}

// API-PD-003: GET /v1/parent/learners/{learnerId}/apps — compact Current/Past
// app selectors only (PD2-G02). The per-app detail endpoint remains at
// /apps/{appId} (route.ts in the sibling [appId] segment), now treated as an
// internal/compat detail lookup — the frozen selector shape lives here.
export async function GET(request: Request, { params }: { params: { learnerId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.detail.read", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  try {
    const selectors = listParentLearnerAppSelectors(guard.parent.session.sub, params.learnerId, new Date());
    const etag = `"${selectors.compositionVersion}"`;
    const headers = { "Cache-Control": "private, no-cache", ETag: etag, Vary: "Cookie" };
    const conditional = request.headers.get("if-none-match")?.split(",")
      .map((value) => value.trim().replace(/^W\//, "")).includes(etag);
    if (conditional) return new NextResponse(null, { status: 304, headers });
    return NextResponse.json(selectors, { headers });
  } catch (error) {
    const code = error instanceof ParentLearnerDetailError ? error.code : "LEARNER_APPS_FAILED";
    return NextResponse.json({ error: code }, { status: code === "RESOURCE_NOT_FOUND" ? 404 : 400,
      headers: { "Cache-Control": "no-store" } });
  }
}
