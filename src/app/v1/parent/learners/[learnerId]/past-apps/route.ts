import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireEndUserAuthorization } from "@/lib/authorization/api-guard";
import { listPastApps, LearnerHomeError } from "@/lib/learner-home/past-apps";

export async function GET(request: Request, { params }: { params: { learnerId: string } }) {
  const guard = await requireEndUserAuthorization(request, "parent.learner.past_apps.read", { learnerId: params.learnerId });
  if (!guard.ok) return guard.response;
  try {
    const pastApps = listPastApps(guard.parent.session.sub, params.learnerId, new Date());
    const version = createHash("sha256").update(JSON.stringify({ learnerId: params.learnerId,
      parentSessionId: guard.parent.session.sid, deviceSessionId: guard.parent.session.did, pastApps }))
      .digest("hex").slice(0, 32);
    const etag = `"${version}"`;
    const headers = { "Cache-Control": "private, no-cache", ETag: etag, Vary: "Cookie" };
    const conditional = request.headers.get("if-none-match")?.split(",")
      .map((value) => value.trim().replace(/^W\//, "")).includes(etag);
    if (conditional) return new NextResponse(null, { status: 304, headers });
    return NextResponse.json({ learnerId: params.learnerId, pastApps, version }, { headers });
  } catch (error) {
    const code = error instanceof LearnerHomeError ? error.code : "PAST_APPS_LIST_FAILED";
    return NextResponse.json({ error: code }, { status: code === "RESOURCE_NOT_FOUND" ? 404 : 400,
      headers: { "Cache-Control": "no-store" } });
  }
}
