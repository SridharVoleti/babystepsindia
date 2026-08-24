import { NextResponse } from "next/server";
import { authorizeProtectedAppApi } from "@/lib/app-authorization/guard";
import { getCurrentProgress, saveCheckpoint, type CheckpointInput } from "@/lib/app-progress/service";
import { progressRouteError, strictObject } from "@/lib/app-progress/route-utils";

const checkpointFields=["expectedProgressVersion","checkpointSequence","stateSchemaVersion","currentLevelKey",
  "currentLessonKey","currentState","checkpointIdempotencyKey","progressSummary"];

export async function GET(request: Request) {
  try { const auth=await authorizeProtectedAppApi(request,"progress.read");
    return NextResponse.json(await getCurrentProgress(auth),{headers:{"Cache-Control":"no-store"}});
  } catch(error) { return progressRouteError(error); }
}

export async function PUT(request: Request) {
  try { const auth=await authorizeProtectedAppApi(request,"progress.write");
    const body=strictObject(await request.json(),checkpointFields) as CheckpointInput;
    return NextResponse.json(await saveCheckpoint(auth,body,new Date()),{headers:{"Cache-Control":"no-store"}});
  } catch(error) { return progressRouteError(error); }
}
