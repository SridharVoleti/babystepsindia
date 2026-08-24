import {NextResponse} from "next/server";
import {requireEndUserAuthorization} from "@/lib/authorization/api-guard";
import {listTechnicalCredits} from "@/lib/session-credit/service";
import {lifecycleError} from "@/lib/session-finalization/route-utils";
export async function GET(request:Request,{params}:{params:{learnerId:string}}){const guard=await requireEndUserAuthorization(request,"parent.learner.credits.read",{learnerId:params.learnerId});if(!guard.ok)return guard.response;
 try{return NextResponse.json({credits:await listTechnicalCredits({actorType:"parent",actorId:guard.parent.session.sub},params.learnerId,new Date())},
  {headers:{"Cache-Control":"private, no-store"}});}catch(error){return lifecycleError(error);}}
