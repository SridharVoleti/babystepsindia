import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { composeParentLearnerDetail, ParentLearnerDetailError } from "@/lib/parent-learner-detail/service";

export async function GET(request: Request, { params }: { params: { learnerId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.detail.read", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  try {
    const detail = await composeParentLearnerDetail(guard.parent.session.sub, params.learnerId, new Date());
    const version = createHash("sha256").update(JSON.stringify(detail)).digest("hex").slice(0, 32);
    const etag = `"${version}"`;
    const headers = { "Cache-Control": "private, no-cache", ETag: etag, Vary: "Cookie" };
    const conditional = request.headers.get("if-none-match")?.split(",")
      .map((value) => value.trim().replace(/^W\//, "")).includes(etag);
    if (conditional) return new NextResponse(null, { status: 304, headers });
    return NextResponse.json({ ...detail, version }, { headers });
  } catch (error) {
    const code = error instanceof ParentLearnerDetailError ? error.code : "LEARNER_DETAIL_FAILED";
    return NextResponse.json({ error: code }, { status: code === "RESOURCE_NOT_FOUND" ? 404 : 400,
      headers: { "Cache-Control": "no-store" } });
  }
}
