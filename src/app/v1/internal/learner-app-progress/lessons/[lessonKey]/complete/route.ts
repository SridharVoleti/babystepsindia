import { NextResponse } from "next/server";
import { authorizeProtectedAppApi } from "@/lib/app-authorization/guard";
import { AppAuthorizationError } from "@/lib/app-authorization/service";
import { completeLesson, type CompleteLessonInput } from "@/lib/app-progress/service";
import { progressRouteError, strictObject } from "@/lib/app-progress/route-utils";

const fields=["levelKey","expectedProgressVersion","checkpointSequence","stateSchemaVersion","nextLevelKey",
  "nextLessonKey","nextState","completionOutcomeCode","completionIdempotencyKey"];

export async function POST(request: Request,{params}:{params:{lessonKey:string}}) {
  try { const auth=await authorizeProtectedAppApi(request,"lesson.complete");
    if (!auth.scopes.includes("progress.write")) throw new AppAuthorizationError("APP_SCOPE_NOT_GRANTED");
    const body=strictObject(await request.json(),fields);
    return NextResponse.json(completeLesson(auth,{...body,lessonKey:params.lessonKey} as CompleteLessonInput,new Date()),
      {headers:{"Cache-Control":"no-store"}});
  } catch(error) { return progressRouteError(error); }
}
