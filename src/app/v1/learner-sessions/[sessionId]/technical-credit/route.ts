import {NextResponse} from "next/server";
import {requireEndUserAuthorization} from "@/lib/authorization/api-guard";
import {checkRateLimit} from "@/lib/auth/rate-limit";
import {claimTechnicalCredit} from "@/lib/session-credit/service";
import {lifecycleError} from "@/lib/session-finalization/route-utils";
import {withLockedEndUserMutation} from "@/lib/authorization/locked-mutation";
export async function POST(request:Request,{params}:{params:{sessionId:string}}){const guard=await requireEndUserAuthorization(request,"learner.technical_issue.confirm");if(!guard.ok)return guard.response;
 if(!checkRateLimit(`technical-credit:${guard.parent.session.sub}:${params.sessionId}`,10,60_000))return NextResponse.json({error:"RATE_LIMITED"},{status:429});
 try{const body=await request.json() as Record<string,unknown>;if(!body||Object.keys(body).some(k=>!["confirmation","idempotencyKey"].includes(k))||
  body.confirmation!==true||typeof body.idempotencyKey!=="string")return NextResponse.json({error:"INVALID_REQUEST"},{status:400});
  return NextResponse.json(await withLockedEndUserMutation({preflight:guard.authorization,action:"learner.technical_issue.confirm",
   resource:{learnerId:guard.authorization.learnerId},mutate:()=>claimTechnicalCredit({actorType:"learner",
   actorId:guard.authorization.learnerId!},params.sessionId,body as {confirmation:boolean;idempotencyKey:string},new Date())}),
   {headers:{"Cache-Control":"private, no-store"}});
 }catch(error){return lifecycleError(error);}}
