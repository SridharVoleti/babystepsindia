import { NextResponse } from "next/server";
import { authorizeProtectedAppApi } from "@/lib/app-authorization/guard";
import { writeProgressSummary, type WriteProgressSummaryInput } from "@/lib/app-progress/service";
import { progressRouteError, strictObject } from "@/lib/app-progress/route-utils";

const fields = ["basedOnProgressVersion", "progressSummary", "summaryIdempotencyKey"];

export async function PUT(request: Request) {
  try {
    const auth = await authorizeProtectedAppApi(request, "progress.summary.write");
    const body = strictObject(await request.json(), fields) as WriteProgressSummaryInput;
    return NextResponse.json(await writeProgressSummary(auth, body, new Date()),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return progressRouteError(error); }
}

