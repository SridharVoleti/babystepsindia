import {NextResponse} from "next/server";
import {requireApiParent} from "@/lib/auth/api-guard";
import {listTechnicalCredits} from "@/lib/session-credit/service";
import {lifecycleError} from "@/lib/session-finalization/route-utils";
export async function GET(_:Request,{params}:{params:{learnerId:string}}){const guard=await requireApiParent();if(!guard.ok)return guard.response;
 try{return NextResponse.json({credits:listTechnicalCredits({actorType:"parent",actorId:guard.context.session.sub},params.learnerId,new Date())},
  {headers:{"Cache-Control":"private, no-store"}});}catch(error){return lifecycleError(error);}}
