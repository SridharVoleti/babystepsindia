import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { composeParentAppDetail, ParentLearnerDetailError } from "@/lib/parent-learner-detail/service";

export async function GET(request: Request, { params }: { params: { learnerId: string; appId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.app_detail.read", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  try {
    const detail = await composeParentAppDetail(guard.parent.session.sub, params.learnerId, params.appId, new Date());
    const version = createHash("sha256").update(JSON.stringify(detail)).digest("hex").slice(0, 32);
    const etag = `"${version}"`;
    const headers = { "Cache-Control": "private, no-cache", ETag: etag, Vary: "Cookie" };
    const conditional = request.headers.get("if-none-match")?.split(",")
      .map((value) => value.trim().replace(/^W\//, "")).includes(etag);
    if (conditional) return new NextResponse(null, { status: 304, headers });
    return NextResponse.json({ ...detail, version }, { headers });
  } catch (error) {
    const code = error instanceof ParentLearnerDetailError ? error.code : "APP_DETAIL_FAILED";
    return NextResponse.json({ error: code }, { status: code === "RESOURCE_NOT_FOUND" ? 404 : 400,
      headers: { "Cache-Control": "no-store" } });
  }
}
