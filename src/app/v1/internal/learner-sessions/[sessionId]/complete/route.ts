import {NextResponse} from "next/server";
import {authorizeProtectedAppApi} from "@/lib/app-authorization/guard";
import {finalizeLearnerSession,SessionFinalizationError} from "@/lib/session-finalization/service";
import {lifecycleError} from "@/lib/session-finalization/route-utils";
import {composeCadenceCelebrationAfterCommit} from "@/lib/cadence-celebration/service";
export async function POST(request:Request,{params}:{params:{sessionId:string}}){try{
 const auth=await authorizeProtectedAppApi(request,"session.complete");if(auth.learnerSessionId!==params.sessionId)throw new SessionFinalizationError("LEARNER_SESSION_BINDING_MISMATCH");
 const body=await request.json() as Record<string,unknown>;const allowed=["expectedSessionVersion","finalProgressVersion","endReasonCode","completionIdempotencyKey","reportedConnectedSeconds"];
 if(!body||Object.keys(body).some(k=>!allowed.includes(k))||!Number.isInteger(body.expectedSessionVersion)||
  !Number.isInteger(body.finalProgressVersion)||typeof body.endReasonCode!=="string"||typeof body.completionIdempotencyKey!=="string"||
  typeof body.reportedConnectedSeconds!=="number"||!Number.isFinite(body.reportedConnectedSeconds))
  return NextResponse.json({error:"INVALID_REQUEST"},{status:400});
 const result=await finalizeLearnerSession(auth,body as never,new Date());
 return NextResponse.json(await composeCadenceCelebrationAfterCommit(auth,body.completionIdempotencyKey as string,result),
  {headers:{"Cache-Control":"no-store"}});
}catch(error){return lifecycleError(error);}}
